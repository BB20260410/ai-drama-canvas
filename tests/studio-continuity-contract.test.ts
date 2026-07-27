import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import {
  STUDIO_CONTINUITY_FIELDS,
  STUDIO_CONTINUITY_UNIT_DURATION_MILLISECONDS,
  createStudioContinuityReadiness,
  normalizeStudioContinuityEntryDraft,
  normalizeStudioContinuityScope,
  studioContinuitySpansOverlap,
  type StudioContinuityEntry,
  type StudioContinuityField,
} from "../src/core/studio-continuity.js";
import {
  STUDIO_P7_CONTINUITY_FIELD_NAMES,
  assertStudioP7UnitPanelContract,
  createStudioP7Fixture,
  isStudioP7TemporaryPath,
  normalizeStudioP7DiscontinuousSpans,
  studioP7CoverageAt,
  studioP7HalfOpenSpanContains,
  unresolvedStudioP7ContinuityFields,
  type StudioP7Fixture,
  type StudioP7HalfOpenSpan,
} from "./helpers/studio-p7-fixture.js";

let fixture: StudioP7Fixture | undefined;

function resolvedContinuityEntry(input: {
  field: StudioContinuityField;
  startMilliseconds: number;
  endMilliseconds: number;
  sequence: number;
}): StudioContinuityEntry {
  const draft = normalizeStudioContinuityEntryDraft({
    entryKind: "observation",
    scope: {
      kind: "panel",
      scopeId: "p7-unit-a-continuity",
      unitId: "p7-unit-a-six-panel",
      unitRevision: 1,
      startMilliseconds: input.startMilliseconds,
      endMilliseconds: input.endMilliseconds,
    },
    subjectId: "character-ahang",
    field: input.field,
    state: {
      status: "resolved",
      value: input.field === "referenceSha256" ? "a".repeat(64) : "P7 fixture 显式状态",
      provenance: [{
        kind: "deterministic-fixture",
        reference: `p7/${input.field}/${input.startMilliseconds}-${input.endMilliseconds}`,
        note: "只用于验证纯合同，不代表视觉验收。",
      }],
    },
  });
  return {
    ...draft,
    sequence: input.sequence,
    createdAt: "2026-07-18T00:00:00.000Z",
  };
}

afterEach(async () => {
  await fixture?.cleanup();
  fixture = undefined;
});

describe("P7 确定性连续性合同夹具", () => {
  it("只在 /tmp 建立 sourceRoots=[] 的 6 格+2 格 Studio 项目、规范资产、逐格 BindingSet 与 raw/labeled CAS", async () => {
    fixture = await createStudioP7Fixture();

    expect(await realpath("/tmp")).toBe(fixture.temporaryRoot);
    expect(isStudioP7TemporaryPath(fixture.parentRoot, fixture.temporaryRoot)).toBe(true);
    expect(isStudioP7TemporaryPath(fixture.root, fixture.temporaryRoot)).toBe(true);
    expect(fixture.shell.project.sourceRoots).toEqual([]);
    expect(fixture.shell.project.outputRoots).toEqual([fixture.root]);
    expect(fixture.shell.manifest).toMatchObject({
      storageMode: "managed",
      startupPolicy: "no-filesystem-scan",
      mediaMode: "project-local-cas",
      legacyRoots: [],
    });

    expect(fixture.units.sixPanel.unit).toMatchObject({
      season: "S03",
      episode: "EP01",
      sequence: 1,
      durationSeconds: 15,
      panelCount: 6,
    });
    expect(fixture.units.sixPanel.panels.map((panel) => ({
      index: panel.index,
      start: panel.startSeconds,
      end: panel.endSeconds,
      duration: panel.durationSeconds,
    }))).toEqual(Array.from({ length: 6 }, (_, index) => ({
      index: index + 1,
      start: index * 2.5,
      end: (index + 1) * 2.5,
      duration: 2.5,
    })));
    expect(fixture.units.twoPanel.unit).toMatchObject({
      season: "S03",
      episode: "EP01",
      sequence: 2,
      durationSeconds: 15,
      panelCount: 2,
    });
    expect(fixture.units.twoPanel.panels.map((panel) => panel.durationSeconds)).toEqual([7.5, 7.5]);
    expect(() => assertStudioP7UnitPanelContract(fixture!.units.sixPanel.panels)).not.toThrow();
    expect(() => assertStudioP7UnitPanelContract(fixture!.units.twoPanel.panels)).not.toThrow();

    expect(Object.values(fixture.assets).map((asset) => [asset.id, asset.category, asset.name])).toEqual([
      ["character-ahang", "character", "阿航"],
      ["scene-stone-room", "scene", "石室"],
      ["prop-complete-golden-mask", "prop", "完整黄金面具"],
    ]);
    expect(fixture.bindings).toHaveLength(8);
    for (const binding of fixture.bindings) {
      expect(binding.confirmedEmpty).toBe(false);
      expect(binding.bindings.map((entry) => entry.assetId).sort()).toEqual([
        "character-ahang",
        "prop-complete-golden-mask",
        "scene-stone-room",
      ]);
      expect(binding.bindings.every((entry) => entry.presence === "required")).toBe(true);
      expect(binding.bindings.every((entry) => /^[a-f0-9]{64}$/u.test(entry.mediaSha256))).toBe(true);
    }

    expect(fixture.panelMediaPairs).toHaveLength(8);
    expect(fixture.allMedia).toHaveLength(19);
    expect(new Set(fixture.allMedia.map((media) => media.imported.sha256))).toHaveLength(19);
    for (const media of fixture.allMedia) {
      expect(isStudioP7TemporaryPath(media.sourcePath, fixture.temporaryRoot)).toBe(true);
      expect(isStudioP7TemporaryPath(media.sourcePath, fixture.root)).toBe(true);
      expect(isStudioP7TemporaryPath(media.imported.objectPath, fixture.temporaryRoot)).toBe(true);
      expect(isStudioP7TemporaryPath(media.imported.objectPath, fixture.root)).toBe(true);
      expect(media.imported.kind).toBe("image");
      expect(media.imported.derivativeStatus).toBe("ready");
      const sourceStat = await lstat(media.sourcePath);
      const objectStat = await lstat(media.imported.objectPath);
      expect(sourceStat.isFile()).toBe(true);
      expect(sourceStat.size).toBeGreaterThan(0);
      expect(objectStat.isFile()).toBe(true);
      expect(objectStat.size).toBeGreaterThan(0);
      if (media.imported.thumbnail) {
        expect(isStudioP7TemporaryPath(media.imported.thumbnail.path, fixture.temporaryRoot)).toBe(true);
        expect(isStudioP7TemporaryPath(media.imported.thumbnail.path, fixture.root)).toBe(true);
        expect((await lstat(media.imported.thumbnail.path)).isFile()).toBe(true);
      }
    }
    for (const asset of Object.values(fixture.assets)) {
      const metadata = await sharp(asset.authorityMedia.sourcePath).metadata();
      expect([metadata.width, metadata.height]).toEqual([48, 72]);
    }
    for (const pair of fixture.panelMediaPairs) {
      expect(path.basename(pair.raw.sourcePath)).toMatch(/_raw\.png$/u);
      expect(path.basename(pair.labeled.sourcePath)).toMatch(/_labeled\.png$/u);
      expect(pair.raw.imported.sha256).not.toBe(pair.labeled.imported.sha256);
      const [rawMetadata, labeledMetadata] = await Promise.all([
        sharp(pair.raw.sourcePath).metadata(),
        sharp(pair.labeled.sourcePath).metadata(),
      ]);
      expect([rawMetadata.width, rawMetadata.height]).toEqual([64, 96]);
      expect([labeledMetadata.width, labeledMetadata.height]).toEqual([64, 96]);
    }
    expect(fixture.visualReviewClaimed).toBe(false);

    console.log(`P7_DETERMINISTIC_FIXTURE_CONTRACT ${JSON.stringify({
      temporaryOnly: true,
      sourceRootsEmpty: true,
      units: 2,
      panels: 8,
      sixPanelDurationsMilliseconds: fixture.units.sixPanel.panels.map((panel) => panel.durationSeconds * 1_000),
      canonicalAssets: 3,
      bindingSets: fixture.bindings.length,
      rawLabeledPairs: fixture.panelMediaPairs.length,
      visualReviewClaimed: fixture.visualReviewClaimed,
    })}`);
  });

  it("锁死九字段名称、2-6 宫格、15000ms、半开区间和不填空档合同", () => {
    expect(STUDIO_P7_CONTINUITY_FIELD_NAMES).toEqual([
      "costume",
      "injury",
      "heldObject",
      "position",
      "facing",
      "emotion",
      "layout",
      "lighting",
      "referenceSha256",
    ]);
    expect(STUDIO_P7_CONTINUITY_FIELD_NAMES).toBe(STUDIO_CONTINUITY_FIELDS);
    expect(STUDIO_CONTINUITY_UNIT_DURATION_MILLISECONDS).toBe(15_000);
    const unresolved = unresolvedStudioP7ContinuityFields("剧本与现有证据均未明确。", ["facing", "referenceSha256"]);
    expect(Object.keys(unresolved)).toEqual([...STUDIO_P7_CONTINUITY_FIELD_NAMES]);
    expect(Object.values(unresolved).every((field) => field.status === "unresolved")).toBe(true);
    expect(unresolved.facing).toMatchObject({ status: "unresolved", required: true });
    expect(unresolved.referenceSha256).toMatchObject({ status: "unresolved", required: true });
    expect(unresolved.costume).toMatchObject({ status: "unresolved", required: false });

    const spans: StudioP7HalfOpenSpan[] = [{
      id: "panel-01-visible",
      scopeKind: "panel",
      scopeId: "p7-unit-a",
      startMilliseconds: 0,
      endMilliseconds: 2_500,
    }, {
      id: "panel-03-visible",
      scopeKind: "panel",
      scopeId: "p7-unit-a",
      startMilliseconds: 5_000,
      endMilliseconds: 7_500,
    }];
    const normalized = normalizeStudioP7DiscontinuousSpans([...spans].reverse());
    expect(normalized).toEqual(spans);
    expect(normalized).toHaveLength(2);
    expect(normalized).not.toContainEqual(expect.objectContaining({ startMilliseconds: 0, endMilliseconds: 7_500 }));
    expect(studioP7HalfOpenSpanContains(normalized[0]!, 0)).toBe(true);
    expect(studioP7HalfOpenSpanContains(normalized[0]!, 2_499)).toBe(true);
    expect(studioP7HalfOpenSpanContains(normalized[0]!, 2_500)).toBe(false);
    expect(studioP7HalfOpenSpanContains(normalized[1]!, 5_000)).toBe(true);
    expect(studioP7HalfOpenSpanContains(normalized[1]!, 7_500)).toBe(false);
    expect(studioP7CoverageAt(normalized, "panel", "p7-unit-a", 3_000)).toEqual([]);
    expect(studioP7CoverageAt(normalized, "panel", "p7-unit-a", 5_000)).toEqual([normalized[1]]);
    expect(() => normalizeStudioP7DiscontinuousSpans([spans[0]!, {
      id: "overlap",
      scopeKind: "panel",
      scopeId: "p7-unit-a",
      startMilliseconds: 2_000,
      endMilliseconds: 3_000,
    }])).toThrow("重叠");

    const firstCoreSpan = normalizeStudioContinuityScope({
      kind: "panel",
      scopeId: "p7-unit-a-continuity",
      unitId: "p7-unit-a-six-panel",
      unitRevision: 1,
      startMilliseconds: 0,
      endMilliseconds: 2_500,
    });
    const touchingCoreSpan = normalizeStudioContinuityScope({
      kind: "panel",
      scopeId: "p7-unit-a-continuity",
      unitId: "p7-unit-a-six-panel",
      unitRevision: 1,
      startMilliseconds: 2_500,
      endMilliseconds: 5_000,
    });
    const overlappingCoreSpan = normalizeStudioContinuityScope({
      kind: "panel",
      scopeId: "p7-unit-a-continuity",
      unitId: "p7-unit-a-six-panel",
      unitRevision: 1,
      startMilliseconds: 2_499,
      endMilliseconds: 5_000,
    });
    expect(studioContinuitySpansOverlap(firstCoreSpan, touchingCoreSpan)).toBe(false);
    expect(studioContinuitySpansOverlap(firstCoreSpan, overlappingCoreSpan)).toBe(true);
    expect(() => normalizeStudioContinuityScope({
      kind: "panel",
      scopeId: "p7-unit-a-continuity",
      unitId: "p7-unit-a-six-panel",
      unitRevision: 1,
      startMilliseconds: 0,
      endMilliseconds: 15_001,
    })).toThrow("半开");

    const readiness = createStudioContinuityReadiness({
      scope: {
        kind: "panel",
        scopeId: "p7-unit-a-continuity",
        unitId: "p7-unit-a-six-panel",
        unitRevision: 1,
        startMilliseconds: 0,
        endMilliseconds: STUDIO_CONTINUITY_UNIT_DURATION_MILLISECONDS,
      },
      subjectId: "character-ahang",
      requiredFields: ["position"],
      currentEntries: [
        resolvedContinuityEntry({ field: "position", startMilliseconds: 0, endMilliseconds: 2_500, sequence: 1 }),
        resolvedContinuityEntry({ field: "position", startMilliseconds: 5_000, endMilliseconds: 7_500, sequence: 2 }),
      ],
      openConflicts: [],
    });
    expect(readiness.ready).toBe(false);
    expect(readiness.blockers).toEqual([
      expect.objectContaining({
        code: "required-state-gap",
        field: "position",
        startMilliseconds: 2_500,
        endMilliseconds: 5_000,
      }),
      expect.objectContaining({
        code: "required-state-gap",
        field: "position",
        startMilliseconds: 7_500,
        endMilliseconds: 15_000,
      }),
    ]);

    const panel = (startSeconds: number, endSeconds: number) => ({
      startSeconds,
      endSeconds,
      durationSeconds: endSeconds - startSeconds,
    });
    expect(() => assertStudioP7UnitPanelContract([panel(0, 15)])).toThrow("2-6");
    expect(() => assertStudioP7UnitPanelContract(Array.from({ length: 7 }, (_, index) => panel(index, index + 1)))).toThrow("2-6");
    expect(() => assertStudioP7UnitPanelContract([panel(0, 7), panel(7, 15)])).not.toThrow();
    expect(() => assertStudioP7UnitPanelContract([panel(0, 7), panel(8, 15)])).toThrow("空档或重叠");

    console.log(`P7_DISCONTINUOUS_SPAN_GAPS ${JSON.stringify({
      fields: STUDIO_P7_CONTINUITY_FIELD_NAMES,
      fieldCount: STUDIO_P7_CONTINUITY_FIELD_NAMES.length,
      halfOpen: true,
      explicitSpanCount: normalized.length,
      gapAtMilliseconds: 3_000,
      gapFilled: readiness.ready,
      gapBlockers: readiness.blockers.map((blocker) => [
        blocker.startMilliseconds,
        blocker.endMilliseconds,
      ]),
      panelMinimum: 2,
      panelMaximum: 6,
      unitDurationMilliseconds: 15_000,
    })}`);
  });
});
