/**
 * T20 下一镜连续状态结构化。
 *
 * raw 节点直接输出结构化字段（非聊天摘要猜测）：
 * - 角色：位置/朝向/视线/动作终点/表情
 * - 道具：持有/损坏/开合
 * - 伤势
 * - 场景：布局/轴线/出入口
 * - 光线/时间/天气
 * - 临时 VFX
 * - 实际参考 SHA
 *
 * 提示词生成只读结构化字段，禁止自由文本猜测。
 */
import { createHash } from "node:crypto";

export const NEXT_SHOT_CONTINUITY_SCHEMA_VERSION = 2 as const;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/** 角色连续状态。 */
export interface CharacterContinuityState {
  assetId: string;
  /** 实际末格可见服装/外观状态；旧 v2 快照可能缺失，新续作必须补齐。 */
  costumeState?: string;
  /** 画面位置（如"左前景"、"中心"、"右背景"）。 */
  position: string;
  /** 朝向（如"面向镜头"、"背对"、"侧身向左"）。 */
  facing: string;
  /** 视线方向。 */
  gazeDirection: string;
  /** 动作终点姿态。 */
  actionEndPose: string;
  /** 下一镜第一拍允许承接的动作起点；不是把后续事件提前塞入当前镜。 */
  nextActionStart?: string;
  /** 表情（FACS 分级描述）。 */
  expression: string;
  /** 伤势/物理状态变化。 */
  injuryState?: string;
}

/** 道具连续状态。 */
export interface PropContinuityState {
  assetId: string;
  /** 持有者 assetId（null 表示无人持有）。 */
  heldBy: string | null;
  /** 实际末格中的空间位置；旧 v2 快照可能缺失。 */
  position?: string;
  /** 物理状态（如"完好"、"裂开"、"打开"）。 */
  physicalState: string;
}

/** 场景连续状态。 */
export interface SceneContinuityState {
  /** 场景布局描述。 */
  layout: string;
  /** 轴线方向（180度规则）。 */
  axisLine: string;
  /** 屏幕运动/视线方向，防止下一镜镜像反转。 */
  screenDirection?: string;
  /** 出入口位置。 */
  entryExits: string[];
  /** 光线方向与质感。 */
  lighting: string;
  /** 时间（如"黄昏"、"深夜"）。 */
  timeOfDay: string;
  /** 天气。 */
  weather?: string;
  /** 当前镜结束时的剪辑出点，供下一镜入点承接。 */
  cutExit?: string;
}

/** 临时 VFX 状态。 */
export interface VfxContinuityState {
  /** VFX 类型标识。 */
  vfxId: string;
  /** 描述。 */
  description: string;
  /** 强度（0-1）。 */
  intensity: number;
  /** 是否延续到下一镜。 */
  continuesToNext: boolean;
}

/** 完整的下一镜连续状态快照。 */
export interface NextShotContinuitySnapshot {
  schemaVersion: typeof NEXT_SHOT_CONTINUITY_SCHEMA_VERSION;
  kind: "studio-next-shot-continuity";
  /** 来源单元。 */
  sourceUnitId: string;
  /** 来源宫格（最后一格）。 */
  sourcePanelId: string;
  /** 来源 raw SHA。 */
  sourceRawSha256: string;
  /** 角色状态列表。 */
  characters: CharacterContinuityState[];
  /** 道具状态列表。 */
  props: PropContinuityState[];
  /** 场景状态。 */
  scene: SceneContinuityState;
  /** 临时 VFX。 */
  vfx: VfxContinuityState[];
  /** 实际引用的参考 SHA 列表。 */
  referenceSha256List: string[];
  /** 连续性指纹（用于提示词生成锚定）。 */
  continuityFingerprint: string;
  createdAt: string;
}

/** 旧 v2 快照保持可读；只有这些续作关键字段闭合后才能进入下一冻结包。 */
export function nextShotContinuityContinuationGaps(
  snapshot: NextShotContinuitySnapshot,
): string[] {
  const gaps: string[] = [];
  for (const character of snapshot.characters) {
    if (!character.costumeState?.trim()) gaps.push(`character:${character.assetId}:costumeState`);
    if (!character.nextActionStart?.trim()) gaps.push(`character:${character.assetId}:nextActionStart`);
  }
  for (const prop of snapshot.props) {
    if (!prop.position?.trim()) gaps.push(`prop:${prop.assetId}:position`);
  }
  if (!snapshot.scene.screenDirection?.trim()) gaps.push("scene:screenDirection");
  if (!snapshot.scene.cutExit?.trim()) gaps.push("scene:cutExit");
  return gaps.sort((left, right) => left.localeCompare(right, "en"));
}

/**
 * 从连续性九字段 heads 构建结构化快照。
 * 提示词生成消费此结构，禁止从聊天摘要或自由文本猜测。
 */
export function buildNextShotContinuitySnapshot(input: {
  sourceUnitId: string;
  sourcePanelId: string;
  sourceRawSha256: string;
  characters: CharacterContinuityState[];
  props: PropContinuityState[];
  scene: SceneContinuityState;
  vfx: VfxContinuityState[];
  referenceSha256List: string[];
}): NextShotContinuitySnapshot {
  if (!SHA256_PATTERN.test(input.sourceRawSha256)) {
    throw new Error("sourceRawSha256 必须是小写 SHA-256。");
  }
  const characters = input.characters
    .map((entry) => ({ ...entry }))
    .sort((left, right) => left.assetId.localeCompare(right.assetId, "en"));
  const props = input.props
    .map((entry) => ({ ...entry }))
    .sort((left, right) => left.assetId.localeCompare(right.assetId, "en"));
  const scene: SceneContinuityState = {
    ...input.scene,
    entryExits: [...input.scene.entryExits].sort((left, right) => left.localeCompare(right, "zh-CN")),
  };
  const vfx = input.vfx
    .map((entry) => {
      if (!Number.isFinite(entry.intensity) || entry.intensity < 0 || entry.intensity > 1) {
        throw new Error(`VFX ${entry.vfxId} intensity 必须位于 0-1。`);
      }
      return { ...entry };
    })
    .sort((left, right) => left.vfxId.localeCompare(right.vfxId, "en"));
  const referenceSha256List = [...new Set(input.referenceSha256List)]
    .map((sha256) => {
      if (!SHA256_PATTERN.test(sha256)) throw new Error("referenceSha256List 必须只包含小写 SHA-256。");
      return sha256;
    })
    .sort((left, right) => left.localeCompare(right, "en"));
  // 确定性指纹：所有结构化字段的稳定哈希
  const fingerprintSource = JSON.stringify({
    schemaVersion: NEXT_SHOT_CONTINUITY_SCHEMA_VERSION,
    kind: "studio-next-shot-continuity",
    sourceUnitId: input.sourceUnitId,
    sourcePanelId: input.sourcePanelId,
    sourceRawSha256: input.sourceRawSha256,
    characters,
    props,
    scene,
    vfx,
    referenceSha256List,
  });
  const continuityFingerprint = createHash("sha256").update(fingerprintSource).digest("hex");

  return deepFreeze({
    schemaVersion: NEXT_SHOT_CONTINUITY_SCHEMA_VERSION,
    kind: "studio-next-shot-continuity",
    sourceUnitId: input.sourceUnitId,
    sourcePanelId: input.sourcePanelId,
    sourceRawSha256: input.sourceRawSha256,
    characters,
    props,
    scene,
    vfx,
    referenceSha256List,
    continuityFingerprint,
    createdAt: new Date().toISOString(),
  });
}
