/**
 * P24：变化分类纯模块（零 import，browser-safe）。
 *
 * 唯一映射点：src/core/studio-trace.ts 与 main 进程（canvas:get-studio-pack-currentness IPC）
 * 共同 import 本模块；renderer 不 import（分类一律经 IPC 投影）；禁止出现第三份映射。
 *
 * 输入词表 = BindingSet/confirmation currentness staleReasons
 * （src/core/studio-production.ts:4544-4583/5067-5156）。
 * 结果面 storedStaleReasons（`${freezeErrorCode}: ${message}` 冻结码格式）禁止作为输入——
 * 那是另一套词表，语义边界见 studio-trace.ts 字段注释。
 *
 * 分类语义：
 * - expected（预期变化）：用户有意推进修订/换 head 导致的可预期漂移（白名单精确串+前缀）。
 * - unexpected（非预期变化）：pin 破坏/实体缺失/权威资产语义变化/一切未知新值（fail-safe）。
 * - 权威资产语义变化（asset-semantic-changed/identity-key-changed/asset-missing）一律 unexpected：
 *   资产为权威资产，任何语义变化必须人工复核，不自动归预期（黄金面具硬锁先例）。
 * - 混合 → unexpected（任一非预期即非预期）；空数组 → current。
 */

export type StudioStaleChangeClassification = "current" | "expected" | "unexpected";

export interface StudioStaleClassificationResult {
  classification: StudioStaleChangeClassification;
  expectedReasons: string[];
  unexpectedReasons: string[];
}

/** 预期变化白名单（精确串）：用户有意推进修订或更换 head。 */
const EXPECTED_EXACT_REASONS: ReadonlySet<string> = new Set([
  "script-changed",
  "prompt-changed",
  "source-spans-changed",
  "unit-changed",
  "binding-set-not-head",
  "analysis-head-changed",
  "empty-confirmation-head-changed",
]);

/** 预期变化白名单（前缀族，reason 带实体后缀）。 */
const EXPECTED_PREFIX_REASONS: readonly string[] = [
  "decision-head-changed:",
  "section-head-changed:",
];

/** 包装词：empty-confirmation-stale:<内层 reason>——拆解内层递归分类。 */
const WRAPPER_PREFIX = "empty-confirmation-stale:";

function isExpectedStaleReason(reason: string): boolean {
  if (EXPECTED_EXACT_REASONS.has(reason)) return true;
  if (EXPECTED_PREFIX_REASONS.some((prefix) => reason.startsWith(prefix))) return true;
  if (reason.startsWith(WRAPPER_PREFIX)) {
    const inner = reason.slice(WRAPPER_PREFIX.length);
    return inner.length > 0 && isExpectedStaleReason(inner);
  }
  return false;
}

export function classifyStudioStaleReasons(staleReasons: string[]): StudioStaleClassificationResult {
  const expectedReasons: string[] = [];
  const unexpectedReasons: string[] = [];
  for (const reason of staleReasons) {
    if (isExpectedStaleReason(reason)) expectedReasons.push(reason);
    else unexpectedReasons.push(reason);
  }
  const classification: StudioStaleChangeClassification = staleReasons.length === 0
    ? "current"
    : unexpectedReasons.length > 0
      ? "unexpected"
      : "expected";
  return { classification, expectedReasons, unexpectedReasons };
}
