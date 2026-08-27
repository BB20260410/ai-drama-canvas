import type { StudioUnitGridGenerationFreezePack } from "./studio-unit-grid-generation.js";

export const UNIT_GRID_BRIEF_TEMPLATE_ID = "unit-grid-brief-template-v1" as const;
export const UNIT_GRID_BRIEF_CONTRACT_KIND = "unit-grid-brief-contract" as const;
export const IDENTITY_SENTENCE_MAX_CHARS = 40;
export const MAX_IDENTITY_REFS_PER_ASSET = 3;
export const MAX_BEATS = 6;
export const MIN_BEATS = 2;

const FORBIDDEN_LABELS: Readonly<Record<string, string>> = {
  titles: "画面内标题",
  "panel-numbers": "宫格编号",
  durations: "时长数字",
  "dialogue-text": "对白文字",
  subtitles: "字幕",
  watermarks: "水印/标志",
  ui: "界面控件",
  "pseudo-text": "伪文字",
};

export interface UnitGridBriefIdentityLock {
  assetId: string;
  mediaSha256: string;
  purpose: string;
  identitySentence: string;
}

export interface UnitGridBriefBeat {
  order: number;
  panelId: string;
  startSeconds?: number;
  endSeconds?: number;
  durationSeconds: number;
  shotType?: "original" | "extension";
  shotComposition: string;
  filmingMethod: string;
  visualAction: string;
  dialogue?: string;
  previousStanding?: {
    order: number;
    shotComposition: string;
    filmingMethod: string;
    visualAction: string;
  };
  sceneLighting?: string;
  costumeState?: string;
}

export interface UnitGridBriefContract {
  schemaVersion: 1;
  kind: typeof UNIT_GRID_BRIEF_CONTRACT_KIND;
  templateId: typeof UNIT_GRID_BRIEF_TEMPLATE_ID;
  slots: {
    STYLE_LOCK: {
      look: string;
      aspect: "9:16";
      layout: "9:16-vertical-ordered-grid";
      styleAssetIds: string[];
    };
    IDENTITY_LOCK: UnitGridBriefIdentityLock[];
    SCENE_LOCK: UnitGridBriefIdentityLock[];
    BEATS: UnitGridBriefBeat[];
    HARD_NEGS: string[];
    DELTA_ONLY: string | null;
    OUTPUT_RULES: string[];
  };
  controlReferenceCount: number;
  continuation: boolean;
}

function clip(value: string, max: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= max) return trimmed;
  return trimmed.slice(0, max);
}

function identitySentence(roles: readonly string[]): string {
  const text = roles.filter(Boolean).join("、") || "以 controlRef 为准";
  return clip(text, IDENTITY_SENTENCE_MAX_CHARS);
}

function categoryOf(reference: StudioUnitGridGenerationFreezePack["controlReferences"][number]): string {
  return reference.categories[0] ?? "";
}

function purposeOf(reference: StudioUnitGridGenerationFreezePack["controlReferences"][number]): string {
  return reference.referenceUsages?.[0]?.usage.purpose
    ?? (reference.categories.includes("continuity") ? "continuity" : "identity");
}

function lockFromReference(
  reference: StudioUnitGridGenerationFreezePack["controlReferences"][number],
): UnitGridBriefIdentityLock {
  return {
    assetId: reference.coveredAssetIds[0] ?? reference.referenceId,
    mediaSha256: reference.mediaSha256,
    purpose: purposeOf(reference),
    identitySentence: identitySentence(reference.roles),
  };
}

function takePerAsset(
  references: StudioUnitGridGenerationFreezePack["controlReferences"],
  category: string,
  limitPerAsset: number,
): UnitGridBriefIdentityLock[] {
  const counts = new Map<string, number>();
  const locks: UnitGridBriefIdentityLock[] = [];
  for (const reference of references) {
    if (categoryOf(reference) !== category) continue;
    const assetId = reference.coveredAssetIds[0] ?? reference.referenceId;
    const used = counts.get(assetId) ?? 0;
    if (used >= limitPerAsset) continue;
    counts.set(assetId, used + 1);
    locks.push(lockFromReference(reference));
  }
  return locks;
}

function deltaOnly(pack: StudioUnitGridGenerationFreezePack): string | null {
  if (!pack.continuationSource && !pack.request.continuationSource) return null;
  return "只写变化：动作、机位、光色、终点状态。已验收脸/服/场景不复述。身份锁以本单元 controlRefs 为最高权威。";
}

/** 从已冻结 pack 投影 7 槽合同；不改 renderedPrompt，不写盘。 */
export function composeUnitGridBriefContract(
  pack: StudioUnitGridGenerationFreezePack,
): UnitGridBriefContract {
  const references = pack.request.controlReferences;
  if (references.length === 0) {
    throw new Error("unit-grid Brief 合同缺少 controlReferences，禁止降级 text-only。");
  }
  const beats: UnitGridBriefBeat[] = pack.panels.slice(0, MAX_BEATS).map((panel, index, all) => {
    const previous = index > 0 ? all[index - 1] : undefined;
    const shotType = panel.instruction.shotType === "extension" || panel.instruction.shotType === "original"
      ? panel.instruction.shotType
      : undefined;
    return {
      order: panel.order,
      panelId: panel.panelId,
      startSeconds: panel.startSeconds,
      endSeconds: panel.endSeconds,
      durationSeconds: panel.durationSeconds,
      ...(shotType ? { shotType } : {}),
      shotComposition: panel.instruction.shotComposition,
      filmingMethod: panel.instruction.filmingMethod,
      visualAction: panel.instruction.visualAction,
      ...(panel.instruction.dialogue ? { dialogue: clip(panel.instruction.dialogue, 80) } : {}),
      ...(panel.instruction.sceneLighting?.trim()
        ? { sceneLighting: clip(panel.instruction.sceneLighting, 80) }
        : {}),
      ...(panel.instruction.costumeState?.trim()
        ? { costumeState: clip(panel.instruction.costumeState, 80) }
        : {}),
      ...(previous
        ? {
          previousStanding: {
            order: previous.order,
            shotComposition: previous.instruction.shotComposition,
            filmingMethod: previous.instruction.filmingMethod,
            visualAction: previous.instruction.visualAction,
          },
        }
        : {}),
    };
  });
  if (beats.length === 0) {
    throw new Error("unit-grid Brief 合同缺少 BEATS。");
  }
  const panelNegatives = pack.panels
    .map((panel) => panel.instruction.negativePrompt?.trim() ?? "")
    .filter(Boolean);
  const hardNegs = [
    ...pack.request.forbidden.map((item) => FORBIDDEN_LABELS[item] ?? item),
    ...panelNegatives,
  ];
  const uniqueNegs = [...new Set(hardNegs)];
  const styleAssetIds = [...new Set(
    references.filter((reference) => categoryOf(reference) === "style")
      .map((reference) => reference.coveredAssetIds[0] ?? reference.referenceId),
  )];
  return {
    schemaVersion: 1,
    kind: UNIT_GRID_BRIEF_CONTRACT_KIND,
    templateId: UNIT_GRID_BRIEF_TEMPLATE_ID,
    slots: {
      STYLE_LOCK: {
        look: styleAssetIds.length > 0
          ? "跟随风格控制参考，禁止另起画风"
          : "photoreal cinematic, controlled contrast, natural skin",
        aspect: "9:16",
        layout: "9:16-vertical-ordered-grid",
        styleAssetIds,
      },
      IDENTITY_LOCK: takePerAsset(references, "character", MAX_IDENTITY_REFS_PER_ASSET),
      SCENE_LOCK: takePerAsset(references, "scene", MAX_IDENTITY_REFS_PER_ASSET),
      BEATS: beats,
      HARD_NEGS: uniqueNegs,
      DELTA_ONLY: deltaOnly(pack),
      OUTPUT_RULES: [
        "只输出一张图",
        `整板 ${pack.target.panelCount} 宫格，禁止把多格画进同一格`,
        "raw 禁止字幕、标题、水印、宫格编号、对白文字",
        "身份以 controlRefs 为准，禁止用长文本换脸",
      ],
    },
    controlReferenceCount: references.length,
    continuation: Boolean(pack.continuationSource ?? pack.request.continuationSource),
  };
}

/** 给代理阅读的短文本；身份句已截断，避免把长 prompt 再铺一遍。 */
export function renderUnitGridBriefContractText(contract: UnitGridBriefContract): string {
  const { slots } = contract;
  const identity = slots.IDENTITY_LOCK
    .map((entry) => `${entry.assetId} ${entry.identitySentence} sha256:${entry.mediaSha256.slice(0, 12)}`)
    .join("；") || "无角色控制参考";
  const scenes = slots.SCENE_LOCK
    .map((entry) => `${entry.assetId} sha256:${entry.mediaSha256.slice(0, 12)}`)
    .join("；") || "无场景控制参考";
  const beats = slots.BEATS
    .map((beat) => {
      const overlay = [
        beat.sceneLighting ? `光:${clip(beat.sceneLighting, 24)}` : "",
        beat.costumeState ? `服:${clip(beat.costumeState, 24)}` : "",
      ].filter(Boolean).join(" ");
      const timing = Number.isFinite(beat.startSeconds) && Number.isFinite(beat.endSeconds)
        ? `${beat.startSeconds}–${beat.endSeconds}s ${beat.durationSeconds}s`
        : `${beat.durationSeconds}s`;
      const shot = beat.shotType === "extension" ? "扩写" : beat.shotType === "original" ? "原镜" : "";
      const self = `G${beat.order} ${timing}${shot ? ` ${shot}` : ""} ${beat.shotComposition}/${beat.filmingMethod} ${clip(beat.visualAction, 48)}${overlay ? ` ${overlay}` : ""}`;
      if (!beat.previousStanding) return self;
      return `${self} ← G${beat.previousStanding.order} ${beat.previousStanding.shotComposition}/${beat.previousStanding.filmingMethod}`;
    })
    .join(" | ");
  const delta = slots.DELTA_ONLY ?? "非续镜：按 BEATS 完整执行";
  return [
    `STYLE_LOCK ${slots.STYLE_LOCK.aspect} ${slots.STYLE_LOCK.look}`,
    `IDENTITY_LOCK ${identity}`,
    `SCENE_LOCK ${scenes}`,
    `BEATS ${beats}`,
    `HARD_NEGS ${slots.HARD_NEGS.join("、")}`,
    `DELTA_ONLY ${delta}`,
    `OUTPUT_RULES ${slots.OUTPUT_RULES.join("；")}`,
  ].join("\n");
}
