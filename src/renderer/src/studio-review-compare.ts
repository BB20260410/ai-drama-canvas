/**
 * P22 审片对比与批注纯函数（可直接断言）。
 * |A−B| 绝对值亮度合成（本项目自定实现语义，非 xSTUDIO 文档字面 A−B）、
 * wipe 分割线百分比、批注 id 确定性派生（Core 仅校验不改写）。
 * 本模块禁止 node:* 依赖（renderer 运行环境无 Node 内置模块）；sha256 为自研纯 TS 实现。
 */

/* eslint-disable no-bitwise */
const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotr(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits));
}

/** 自研纯 TS sha256（同步、无环境依赖；输入 UTF-8 字符串，输出 64 位小写 hex）。 */
export function sha256HexUtf8(message: string): string {
  const bytes = new TextEncoder().encode(message);
  const bitLengthHi = Math.floor(bytes.length / 0x20000000);
  const bitLengthLo = bytes.length * 8;
  const paddedLength = (((bytes.length + 8) >> 6) + 1) << 6;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 8, bitLengthHi);
  view.setUint32(paddedLength - 4, bitLengthLo);
  const state = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const w = new Uint32Array(64);
  for (let block = 0; block < paddedLength; block += 64) {
    for (let index = 0; index < 16; index += 1) w[index] = view.getUint32(block + index * 4);
    for (let index = 16; index < 64; index += 1) {
      const s0 = rotr(w[index - 15]!, 7) ^ rotr(w[index - 15]!, 18) ^ (w[index - 15]! >>> 3);
      const s1 = rotr(w[index - 2]!, 17) ^ rotr(w[index - 2]!, 19) ^ (w[index - 2]! >>> 10);
      w[index] = (w[index - 16]! + s0 + w[index - 7]! + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = state as unknown as [number, number, number, number, number, number, number, number];
    for (let index = 0; index < 64; index += 1) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + s1 + ch + SHA256_K[index]! + w[index]!) >>> 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + maj) >>> 0;
      h = g; g = f; f = e; e = (d + temp1) >>> 0;
      d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
    }
    state[0] = (state[0]! + a) >>> 0;
    state[1] = (state[1]! + b) >>> 0;
    state[2] = (state[2]! + c) >>> 0;
    state[3] = (state[3]! + d) >>> 0;
    state[4] = (state[4]! + e) >>> 0;
    state[5] = (state[5]! + f) >>> 0;
    state[6] = (state[6]! + g) >>> 0;
    state[7] = (state[7]! + h) >>> 0;
  }
  return [...state].map((word) => word.toString(16).padStart(8, "0")).join("");
}

export interface RgbaImage {
  width: number;
  height: number;
  data: Uint8ClampedArray<ArrayBuffer>;
}

/** |A−B| 逐像素绝对值合成（RGB 通道，alpha 取 255）。尺寸不一致时 fail-closed。 */
export function composeAbsDifference(a: RgbaImage, b: RgbaImage): RgbaImage {
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error(`差分预检要求两图同尺寸，当前 ${a.width}×${a.height} vs ${b.width}×${b.height}。`);
  }
  const out = new Uint8ClampedArray(a.data.length);
  for (let index = 0; index < a.data.length; index += 4) {
    out[index] = Math.abs(a.data[index]! - b.data[index]!);
    out[index + 1] = Math.abs(a.data[index + 1]! - b.data[index + 1]!);
    out[index + 2] = Math.abs(a.data[index + 2]! - b.data[index + 2]!);
    out[index + 3] = 255;
  }
  return { width: a.width, height: a.height, data: out };
}

/** wipe 分割线百分比（0-100，拖拽 x 对容器宽的 clamp）。 */
export function wipeDividerPercent(offsetX: number, containerWidth: number): number {
  if (!Number.isFinite(offsetX) || !Number.isFinite(containerWidth) || containerWidth <= 0) return 50;
  return Math.min(100, Math.max(0, Math.round((offsetX / containerWidth) * 1000) / 10));
}

export const STUDIO_REVIEW_ANNOTATION_CATEGORY_LABELS = {
  face: "脸",
  hair: "发型",
  costume: "服装",
  marking: "犬纹",
  "golden-mask": "黄金面具",
  scene: "场景",
  prop: "道具",
} as const;
export type StudioReviewAnnotationCategory = keyof typeof STUDIO_REVIEW_ANNOTATION_CATEGORY_LABELS;

export interface AnnotationDraftGeometry {
  kind: "rect" | "point";
  category?: StudioReviewAnnotationCategory;
  x: number;
  y: number;
  width: number;
  height: number;
  note: string;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right, "en")).map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** 批注 id 确定性派生：对全内容（kind+category+geometry+note）取 sha256 前 12；同内容同 id、改内容换 id。 */
export function deriveAnnotationId(input: AnnotationDraftGeometry): string {
  return `ann-${sha256HexUtf8(stableStringify({
    kind: input.kind,
    category: input.category ?? null,
    x: input.x,
    y: input.y,
    width: input.width,
    height: input.height,
    note: input.note,
  })).slice(0, 12)}`;
}

/** 集合内 id 唯一化：冲突依次追加 -2/-3…（确定性，Core 校验唯一）。 */
export function assignUniqueAnnotationIds<T extends AnnotationDraftGeometry>(drafts: readonly T[]): Array<T & { id: string }> {
  const used = new Set<string>();
  return drafts.map((draft) => {
    let id = deriveAnnotationId(draft);
    let suffix = 2;
    while (used.has(id)) {
      id = `${deriveAnnotationId(draft)}-${suffix}`;
      suffix += 1;
    }
    used.add(id);
    return { ...draft, id };
  });
}

/** 七类分类摘要前缀（rework/pass 的 note 装配，确定性）。 */
export function annotationCategorySummary(categories: readonly StudioReviewAnnotationCategory[]): string {
  const unique = [...new Set(categories)];
  if (unique.length === 0) return "";
  return `问题分类：${unique.map((category) => STUDIO_REVIEW_ANNOTATION_CATEGORY_LABELS[category]).join("/")}`;
}

/** criteria.note 确定性拼接，超 maxBytes 截断并追加省略号。 */
export function joinCriteriaNotes(notes: readonly string[], maxLength = 4_000): string {
  const joined = notes.map((note) => note.trim()).filter(Boolean).join("；");
  if (joined.length <= maxLength) return joined;
  return `${joined.slice(0, maxLength - 1)}…`;
}

export interface ReviewCriterionDraft {
  code: string;
  status: "pass" | "fail" | "not-applicable";
  note: string;
}

/** criteria 装配（规范 §2.2 钉死）：有分类批注时=分类码集合（字母序）+恒含 raw-labeled-pair；无分类批注时回退既有三码。 */
export function buildReviewCriteria(
  decision: "pass" | "rework" | "reject",
  categorizedDrafts: ReadonlyArray<{ category: StudioReviewAnnotationCategory; note: string }>,
  fallbackNote: string,
): ReviewCriterionDraft[] {
  if (categorizedDrafts.length === 0) {
    return [
      { code: "identity-consistency", status: decision === "pass" ? "pass" : "fail", note: fallbackNote },
      { code: "scene-prop-continuity", status: decision === "pass" ? "pass" : "not-applicable", note: fallbackNote },
      { code: "raw-labeled-pair", status: "pass", note: "raw/labeled 成对身份由账本验证。" },
    ];
  }
  const codes = [...new Set(categorizedDrafts.map((draft) => draft.category))].sort((left, right) => left.localeCompare(right, "en"));
  const criteria: ReviewCriterionDraft[] = codes.map((code) => ({
    code,
    status: decision === "pass" ? "pass" : "fail",
    note: joinCriteriaNotes(categorizedDrafts.filter((draft) => draft.category === code).map((draft) => draft.note)),
  }));
  criteria.push({ code: "raw-labeled-pair", status: "pass", note: "raw/labeled 成对身份由账本验证。" });
  return criteria;
}
