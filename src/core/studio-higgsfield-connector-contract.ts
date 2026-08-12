/**
 * Higgsfield connector 的纯能力合同。
 *
 * 该模块不读写账本、不访问工程，也不调用外部 connector。队列与视频 owner
 * 都只能依赖这层纯合同，避免两个持久化 owner 形成运行时循环依赖。
 */

const MAX_CAPABILITY_OBSERVATION_AGE_MS = 2 * 60 * 60 * 1_000;

export const HIGGSFIELD_SEEDANCE25_UNLIMITED_PROFILE = {
  provider: "higgsfield-connector",
  model: "seedance_2_5",
  mode: "omni_reference",
  outputDurationSeconds: 20,
  narrativeDurationSeconds: 15,
  resolution: "720p",
  count: 1,
  generateAudio: true,
  billingMode: "unlimited_only",
  useUnlim: true,
  concurrency: 1,
} as const;

export interface HiggsfieldConnectorCapabilityObservation {
  /** 此观察只能来自 connector 的 models/cost/balance 读取，不应来自网页猜测。 */
  source: "higgsfield-connector";
  observedAt: string;
  unlimAvailable: boolean;
  supportsUnlim: boolean;
  model: string;
  mode: string;
  durationSeconds: number;
  resolution: string;
  adjustments: readonly string[];
  evidenceFingerprint?: string;
}

function capabilityBlockers(observation: HiggsfieldConnectorCapabilityObservation): string[] {
  const blockers: string[] = [];
  if (observation.source !== "higgsfield-connector") blockers.push("connector-source-invalid");
  if (observation.unlimAvailable !== true) blockers.push("unlim-unavailable");
  if (observation.supportsUnlim !== true) blockers.push("model-does-not-support-unlim");
  if (observation.model !== HIGGSFIELD_SEEDANCE25_UNLIMITED_PROFILE.model) blockers.push("model-adjusted");
  if (observation.mode !== HIGGSFIELD_SEEDANCE25_UNLIMITED_PROFILE.mode) blockers.push("mode-adjusted");
  if (observation.durationSeconds !== HIGGSFIELD_SEEDANCE25_UNLIMITED_PROFILE.outputDurationSeconds) blockers.push("duration-adjusted");
  if (observation.resolution !== HIGGSFIELD_SEEDANCE25_UNLIMITED_PROFILE.resolution) blockers.push("resolution-adjusted");
  if (observation.adjustments.length) blockers.push("provider-adjustments-present");
  return blockers;
}

/**
 * 可单测的纯门禁。特别保留 `supportsUnlim` 缺失视为 false，避免 connector
 * schema 升级/降级时把“不知道”错误解释成可以免费调用。
 */
export function evaluateHiggsfieldUnlimitedCapability(
  observation: Partial<HiggsfieldConnectorCapabilityObservation>,
): { callAllowed: boolean; blockers: string[] } {
  const preliminary: string[] = [];
  if (observation.source !== "higgsfield-connector") preliminary.push("connector-source-invalid");
  const observedAtMs = typeof observation.observedAt === "string" ? Date.parse(observation.observedAt) : Number.NaN;
  if (!Number.isFinite(observedAtMs)) preliminary.push("capability-observation-time-invalid");
  else if (Date.now() - observedAtMs > MAX_CAPABILITY_OBSERVATION_AGE_MS || observedAtMs - Date.now() > 5 * 60_000) {
    preliminary.push("capability-observation-stale");
  }
  const normalized: HiggsfieldConnectorCapabilityObservation = {
    source: observation.source === "higgsfield-connector" ? observation.source : "higgsfield-connector",
    observedAt: typeof observation.observedAt === "string" ? observation.observedAt : "",
    unlimAvailable: observation.unlimAvailable === true,
    supportsUnlim: observation.supportsUnlim === true,
    model: typeof observation.model === "string" ? observation.model : "",
    mode: typeof observation.mode === "string" ? observation.mode : "",
    durationSeconds: Number(observation.durationSeconds),
    resolution: typeof observation.resolution === "string" ? observation.resolution : "",
    adjustments: Array.isArray(observation.adjustments) ? observation.adjustments : ["capability-adjustments-unknown"],
  };
  const blockers = [...preliminary, ...capabilityBlockers(normalized)];
  return { callAllowed: blockers.length === 0, blockers };
}

export function sanitizeHiggsfieldRemoteObservation(value: string | undefined): string | null {
  if (!value) return null;
  const redacted = value
    .replace(/https?:\/\/[^\s"'<>]+/giu, "[redacted-url]")
    .replace(/\b(?:proxy-)?authorization\s*[=:]\s*[^\r\n,;]+/giu, "[redacted-authorization]")
    .replace(/\bBearer\s+[^\s,;]+/giu, "Bearer [redacted]")
    .replace(
      /\b(?:password|passwd|credential|signature|session(?:id)?|access[_-]?key|refresh[_-]?token|token|cookie|secret|api[_-]?key)\s*[=:]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu,
      "[redacted-secret]",
    )
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu, "[redacted-email]")
    .trim();
  return redacted ? redacted.slice(0, 200) : null;
}
