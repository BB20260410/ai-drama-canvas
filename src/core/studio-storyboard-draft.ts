import { createHash } from "node:crypto";
import {
  assertUtf16Range,
  exactCandidatesFromIdentityIndex,
  getStudioTextRevision,
  readStudioProductionUnitSnapshot,
  type StudioTextRevision,
} from "./studio-production.js";
import {
  getStudioIdentityIndexSnapshot,
  listStudioIdentityIndex,
} from "./material-studio.js";

/**
 * P20 确定性拆格建议器（纯函数，clean-room 借鉴 fusion semantic-beat-v1 思路）。
 *
 * 边界：
 * - 纯函数、确定性：同输入同输出；无缓存、无存储、无 LLM、不调用任何写路径（含 analyzeStudioPanelAssetMentions）。
 * - 只负责结构骨架：拆句（终止符 + 换行 + 连续终止符归并）、0.1s 边界时长分配、sourceSpans 锚定、shotType 规则、资产带入建议（ambiguous 必须显式裁决）。
 * - v1 时长分配仅按文本长度贪心；转折词/时间锚识别留待后续阶段接线（规范 v2.2 附录 A-6）。
 * - 不猜动作/景别/对白/提示词内容（由 Agent 填写）；不猜默认文档/最新 revision。
 * - extension 建议格（显式请求格数超过文本可拆格数时的末尾连续后缀）时间字段为 0/0/0：
 *   Agent 提交前必须在目标单元真实总时长内重排全部格时长（normalizeUnitDraft 拒绝 0 时长）。
 */

export const STUDIO_STORYBOARD_DRAFT_MAX_TEXT_CHARACTERS = 50_000 as const;
const DEFAULT_UNIT_TOTAL_SECONDS = 15;
const MIN_PANEL_SECONDS = 1.0;
const MIN_PANEL_COUNT = 2;
const MAX_PANEL_COUNT = 6;
const IDENTITY_SNAPSHOT_CHUNK = 256;
const IDENTITY_KEY_MAX_LENGTH = 64;

export interface StudioStoryboardDraftInput {
  scriptRevisionId?: string;
  unitId?: string;
  panelCount?: number;
  /**
   * 可选的剧本文本选区。偏移与 String#slice 一致，且产出的 sourceSpans
   * 始终保持为原修订的绝对 UTF-16 偏移，不创建脱离原文的平行文本。
   */
  sourceRange?: StudioStoryboardDraftSourceSpan;
}

export interface StudioStoryboardDraftSourceSpan {
  startOffsetUtf16: number;
  endOffsetUtf16: number;
}

export interface StudioStoryboardDraftUnresolvedProposal {
  surfaceText: string;
  startOffsetUtf16: number;
  endOffsetUtf16: number;
  candidateAssetIds: string[];
}

export interface StudioStoryboardDraftPanelSuggestion {
  panelIndex: number;
  shotType: "original" | "extension";
  startSeconds: number;
  endSeconds: number;
  durationSeconds: number;
  sourceSpans: StudioStoryboardDraftSourceSpan[];
  suggestedAssetIds: string[];
  unresolvedProposals: StudioStoryboardDraftUnresolvedProposal[];
  /**
   * Agent 可填的 video_prompt 骨架（时码头已按格时长切好，须再补动作正文）。
   * 校验见 validateStudioVideoPrompt。
   */
  videoPromptScaffold?: string;
}

export interface StudioStoryboardDraftSuggestion {
  schemaVersion: 1;
  kind: "studio-storyboard-draft-suggestion";
  scriptRevisionId: string;
  scriptRevision: number;
  panelCount: number;
  panels: StudioStoryboardDraftPanelSuggestion[];
  fingerprint: string;
}

interface SentenceSlice {
  startUtf16: number;
  endUtf16: number;
  text: string;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b, "en")).map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** 句终止符：全角。！？… 与半角 .!?（半角点前是数字时为小数点，不终止）。 */
function isSentenceTerminator(body: string, charStart: number, char: string): boolean {
  if (char === "。" || char === "！" || char === "？" || char === "…") return true;
  if (char === "." || char === "!" || char === "?") return !/^[0-9]$/u.test(body[charStart - 1] ?? "");
  return false;
}

/** 按 code point 迭代拆句（UTF-16 代理对/emoji 安全；偏移与 assertUtf16Range 的 UTF-16 约定一致）。连续终止符（如 "..."/"……"）归并为一次终止。 */
function splitSentences(body: string): SentenceSlice[] {
  const sentences: SentenceSlice[] = [];
  let sentenceStart = 0;
  let utf16Offset = 0;
  const push = (endUtf16: number) => {
    const text = body.slice(sentenceStart, endUtf16);
    if (text.trim()) sentences.push({ startUtf16: sentenceStart, endUtf16: endUtf16, text });
    sentenceStart = endUtf16;
  };
  const codePoints = [...body];
  for (let index = 0; index < codePoints.length; index += 1) {
    const char = codePoints[index]!;
    const charStart = utf16Offset;
    utf16Offset += char.length;
    if (char === "\n") {
      push(charStart);
      sentenceStart = utf16Offset;
      continue;
    }
    if (!isSentenceTerminator(body, charStart, char)) continue;
    // 连续终止符归并：下一个字符仍是终止符时不切，让整串省略号/感叹号留在当前句。
    const next = codePoints[index + 1];
    if (next !== undefined && next !== "\n" && isSentenceTerminator(body, charStart + char.length, next)) continue;
    push(utf16Offset);
  }
  push(body.length);
  return sentences.filter((sentence) => sentence.text.trim().length > 0);
}

/** 句按序归并到 panelCount 桶（greedy 按文本长度比例，确定性）。 */
function groupSentences(sentences: SentenceSlice[], panelCount: number): SentenceSlice[][] {
  const totalLength = sentences.reduce((sum, sentence) => sum + sentence.text.length, 0) || 1;
  const target = totalLength / panelCount;
  const buckets: SentenceSlice[][] = [];
  let current: SentenceSlice[] = [];
  let currentLength = 0;
  let remainingSentences = sentences.length;
  for (const sentence of sentences) {
    const remainingBuckets = panelCount - buckets.length;
    if (remainingBuckets <= 1) {
      current.push(sentence);
      currentLength += sentence.text.length;
      remainingSentences -= 1;
      continue;
    }
    const sentencesNeeded = remainingSentences - (remainingBuckets - 1);
    if (current.length >= sentencesNeeded || (currentLength >= target && current.length > 0)) {
      buckets.push(current);
      current = [];
      currentLength = 0;
    }
    current.push(sentence);
    currentLength += sentence.text.length;
    remainingSentences -= 1;
  }
  if (current.length > 0) buckets.push(current);
  return buckets;
}

/**
 * 0.1s 边界时长分配：总额严格等于真实单元时长；最小格 1.0s，不足从最大格重分配。
 * 调用前先验证总额可容纳每格下限；防御分支命中即不变量被破坏（fail-closed）。
 */
function allocateSeconds(weights: number[], unitTotalSeconds: number): number[] {
  if (unitTotalSeconds < weights.length * MIN_PANEL_SECONDS) {
    throw new Error(`单元真实时长 ${unitTotalSeconds}s 无法容纳 ${weights.length} 格（每格至少 ${MIN_PANEL_SECONDS}s）。`);
  }
  const total = weights.reduce((sum, value) => sum + value, 0) || 1;
  const seconds = weights.map((weight) => Math.max(MIN_PANEL_SECONDS, Math.round((weight / total) * unitTotalSeconds * 10) / 10));
  let sum = seconds.reduce((acc, value) => acc + value, 0);
  let guard = 100_000;
  while (Math.abs(sum - unitTotalSeconds) > 1e-9 && guard > 0) {
    guard -= 1;
    const largestIndex = seconds.indexOf(Math.max(...seconds));
    if (sum > unitTotalSeconds && seconds[largestIndex]! > MIN_PANEL_SECONDS) {
      seconds[largestIndex] = Math.round((seconds[largestIndex]! - 0.1) * 10) / 10;
      sum = Math.round((sum - 0.1) * 10) / 10;
    } else if (sum < unitTotalSeconds) {
      seconds[largestIndex] = Math.round((seconds[largestIndex]! + 0.1) * 10) / 10;
      sum = Math.round((sum + 0.1) * 10) / 10;
    } else {
      throw new Error("时长分配不变量被破坏（fail-closed）。");
    }
  }
  if (Math.abs(sum - unitTotalSeconds) > 1e-9) throw new Error("时长分配不变量被破坏（fail-closed）。");
  return seconds;
}

async function resolveDraftContext(projectRoot: string, input: StudioStoryboardDraftInput): Promise<{
  scriptRevision: StudioTextRevision;
  unitTotalSeconds: number;
}> {
  if (!input.scriptRevisionId && !input.unitId) {
    throw new Error("scriptRevisionId 与 unitId 至少其一必填；不猜默认文档或最新 revision。");
  }
  if (input.unitId) {
    const snapshot = await readStudioProductionUnitSnapshot(projectRoot, input.unitId);
    if (!snapshot) throw new Error(`生产单元不存在：${input.unitId}`);
    if (input.scriptRevisionId && input.scriptRevisionId !== snapshot.scriptRevision.id) {
      throw new Error(`scriptRevisionId=${input.scriptRevisionId} 与 unitId=${input.unitId} 的冻结剧本修订不一致。`);
    }
    return { scriptRevision: snapshot.scriptRevision, unitTotalSeconds: snapshot.unit.durationSeconds };
  }
  if (input.scriptRevisionId) {
    const revision = await getStudioTextRevision(projectRoot, input.scriptRevisionId);
    if (!revision || revision.documentKind !== "script") throw new Error(`剧本修订不存在：${input.scriptRevisionId}`);
    return { scriptRevision: revision, unitTotalSeconds: DEFAULT_UNIT_TOTAL_SECONDS };
  }
  throw new Error("scriptRevisionId 与 unitId 至少其一必填；不猜默认文档或最新 revision。");
}

/** 有界枚举全部身份 key（分页全量一次，页大小即 normalizeLimit 上限；2..64 字符过滤；共享别名按首次出现去重）。 */
async function enumerateIdentityKeys(projectRoot: string): Promise<string[]> {
  const keys = new Set<string>();
  let cursor: string | undefined;
  for (;;) {
    const page = await listStudioIdentityIndex(projectRoot, { ...(cursor ? { cursor } : {}) });
    for (const entry of page.entries) {
      const value = entry.matchedValue;
      if (!value || value.length > IDENTITY_KEY_MAX_LENGTH || value.length < 2) continue;
      keys.add(value);
    }
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  return [...keys];
}

/** key 在桶内的首个命中位置（逐句定位，偏移 = 句自身 startUtf16 + 句内索引；跳过段不污染偏移）。 */
function locateKeyInBucket(bucket: SentenceSlice[], key: string): { startUtf16: number; endUtf16: number } | null {
  for (const sentence of bucket) {
    const index = sentence.text.indexOf(key);
    if (index >= 0) return { startUtf16: sentence.startUtf16 + index, endUtf16: sentence.startUtf16 + index + key.length };
  }
  return null;
}

async function suggestAssetsForBucket(
  projectRoot: string,
  bucket: SentenceSlice[],
  identityKeys: string[],
): Promise<{ suggestedAssetIds: string[]; unresolvedProposals: StudioStoryboardDraftUnresolvedProposal[] }> {
  const matched = identityKeys.filter((key) => bucket.some((sentence) => sentence.text.includes(key)));
  const suggestedAssetIds = new Set<string>();
  const unresolvedProposals: StudioStoryboardDraftUnresolvedProposal[] = [];
  for (let offset = 0; offset < matched.length; offset += IDENTITY_SNAPSHOT_CHUNK) {
    const chunk = matched.slice(offset, offset + IDENTITY_SNAPSHOT_CHUNK);
    const snapshot = await getStudioIdentityIndexSnapshot(projectRoot, chunk);
    for (const key of chunk) {
      const exact = exactCandidatesFromIdentityIndex(key, undefined, snapshot.entries);
      if (exact.length === 1) {
        suggestedAssetIds.add(exact[0]!.assetId);
        continue;
      }
      if (exact.length > 1) {
        const location = locateKeyInBucket(bucket, key);
        if (!location) continue;
        unresolvedProposals.push({
          surfaceText: key,
          startOffsetUtf16: location.startUtf16,
          endOffsetUtf16: location.endUtf16,
          candidateAssetIds: exact.map((candidate) => candidate.assetId),
        });
      }
    }
  }
  return { suggestedAssetIds: [...suggestedAssetIds], unresolvedProposals };
}

export async function suggestStudioStoryboardDraft(
  projectRoot: string,
  input: StudioStoryboardDraftInput,
): Promise<StudioStoryboardDraftSuggestion> {
  const { scriptRevision, unitTotalSeconds } = await resolveDraftContext(projectRoot, input);
  const fullBody = scriptRevision.body;
  const sourceStart = input.sourceRange?.startOffsetUtf16 ?? 0;
  const sourceEnd = input.sourceRange?.endOffsetUtf16 ?? fullBody.length;
  if (input.sourceRange) {
    assertUtf16Range(fullBody, sourceStart, sourceEnd, "sourceRange");
    if (sourceEnd <= sourceStart) throw new Error("sourceRange 必须是非空剧本文本选区。");
  }
  const body = fullBody.slice(sourceStart, sourceEnd);
  if (body.length > STUDIO_STORYBOARD_DRAFT_MAX_TEXT_CHARACTERS) {
    throw new Error(`剧本正文超过 ${STUDIO_STORYBOARD_DRAFT_MAX_TEXT_CHARACTERS} 字符上限，拒绝拆格（fail-closed）。`);
  }
  if (input.panelCount !== undefined && (!Number.isSafeInteger(input.panelCount) || input.panelCount < MIN_PANEL_COUNT || input.panelCount > MAX_PANEL_COUNT)) {
    throw new Error(`panelCount 必须是 ${MIN_PANEL_COUNT}-${MAX_PANEL_COUNT} 的整数。`);
  }
  // 先在选区内拆句，再把 offset 平移回原修订；后续锚点和身份提议
  // 因而仍可由原始 script revision 复核。
  const sentences = splitSentences(body).map((sentence) => ({
    ...sentence,
    startUtf16: sentence.startUtf16 + sourceStart,
    endUtf16: sentence.endUtf16 + sourceStart,
  }));
  if (sentences.length === 0) throw new Error("剧本正文为空，拒绝拆格（fail-closed）。");
  if (sentences.length < MIN_PANEL_COUNT) {
    throw new Error(`文本仅 ${sentences.length} 句，不足拆为至少 ${MIN_PANEL_COUNT} 个原镜格，拒绝拆格（fail-closed）。`);
  }

  const requestedCount = input.panelCount ?? Math.min(MAX_PANEL_COUNT, Math.max(MIN_PANEL_COUNT, sentences.length));
  const bucketCount = Math.min(requestedCount, sentences.length);
  const buckets = groupSentences(sentences, bucketCount);
  const seconds = allocateSeconds(
    buckets.map((bucket) => bucket.reduce((sum, sentence) => sum + sentence.text.length, 0)),
    unitTotalSeconds,
  );

  const identityKeys = await enumerateIdentityKeys(projectRoot);
  const panels: StudioStoryboardDraftPanelSuggestion[] = [];
  let cursorSeconds = 0;
  for (let index = 0; index < buckets.length; index += 1) {
    const bucket = buckets[index]!;
    const startSeconds = Math.round(cursorSeconds * 10) / 10;
    const durationSeconds = seconds[index]!;
    const endSeconds = Math.round((startSeconds + durationSeconds) * 10) / 10;
    cursorSeconds = endSeconds;
    const { suggestedAssetIds, unresolvedProposals } = await suggestAssetsForBucket(projectRoot, bucket, identityKeys);
    const durationRounded = Math.round((endSeconds - startSeconds) * 10) / 10;
    const beatHint = bucket.map((s) => s.text.trim()).join("").slice(0, 80);
    panels.push({
      panelIndex: index + 1,
      shotType: "original",
      startSeconds,
      endSeconds,
      durationSeconds: durationRounded,
      sourceSpans: bucket.map((sentence) => {
        assertUtf16Range(fullBody, sentence.startUtf16, sentence.endUtf16, `panel ${index + 1} sourceSpans`);
        return { startOffsetUtf16: sentence.startUtf16, endOffsetUtf16: sentence.endUtf16 };
      }),
      suggestedAssetIds,
      unresolvedProposals,
      videoPromptScaffold: `${startSeconds}-${endSeconds}秒：${beatHint || "待补全动作/景别/角色"}`,
    });
  }

  // 显式请求格数超过文本可拆格数：末尾连续后缀 extension 建议（扩写不冒充原镜，禁带 spans；时间 0/0/0，Agent 提交前须在真实单元时长内重排）。
  if (requestedCount > panels.length) {
    for (let index = panels.length; index < requestedCount; index += 1) {
      panels.push({
        panelIndex: index + 1,
        shotType: "extension",
        startSeconds: 0,
        endSeconds: 0,
        durationSeconds: 0,
        sourceSpans: [],
        suggestedAssetIds: [],
        unresolvedProposals: [],
      });
    }
  }

  const semantic = {
    schemaVersion: 1 as const,
    kind: "studio-storyboard-draft-suggestion" as const,
    scriptRevisionId: scriptRevision.id,
    scriptRevision: scriptRevision.ordinal,
    panelCount: panels.length,
    panels,
  };
  return {
    ...semantic,
    fingerprint: createHash("sha256").update(stableJson(semantic), "utf8").digest("hex"),
  };
}
