/**
 * unit-grid / agent-imagegen 候选落盘门禁（纯函数）。
 *
 * 防止 Codex/Grok 执行包装把任意近期 PNG（如 prop Authority）误当成 call 候选。
 * 候选只能是 pre-call 授予的 quarantine 精确路径。
 */
import path from "node:path";

export type StudioImagegenCandidateGateErrorCode =
  | "invalid-input"
  | "candidate-path-mismatch"
  | "candidate-outside-quarantine"
  | "candidate-missing"
  | "candidate-too-small";

export class StudioImagegenCandidateGateError extends Error {
  readonly code: StudioImagegenCandidateGateErrorCode;

  constructor(code: StudioImagegenCandidateGateErrorCode, message: string) {
    super(message);
    this.name = "StudioImagegenCandidateGateError";
    this.code = code;
  }
}

export interface StudioImagegenQuarantineGrant {
  /** quarantine 根目录（含 callId 段） */
  rootPath: string;
  /** 唯一允许的候选绝对路径，通常为 root/candidate.png */
  candidatePath: string;
  /** 执行回执路径，通常为 root/execution-receipt.json */
  receiptPath?: string;
}

export interface StudioImagegenCandidateAcceptance {
  accepted: true;
  candidatePath: string;
  bytes: number;
}

function normalizeAbs(p: string, field: string): string {
  const raw = p?.trim() ?? "";
  if (!raw) throw new StudioImagegenCandidateGateError("invalid-input", `${field} 不能为空。`);
  return path.resolve(raw);
}

/**
 * 判断 candidatePath 是否与 grant 完全一致（解析后），且位于 quarantine root 之下。
 */
export function assertStudioImagegenCandidatePathAllowed(
  grant: StudioImagegenQuarantineGrant,
  observedPath: string,
): string {
  const root = normalizeAbs(grant.rootPath, "grant.rootPath");
  const expected = normalizeAbs(grant.candidatePath, "grant.candidatePath");
  const observed = normalizeAbs(observedPath, "observedPath");

  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (expected !== observed) {
    throw new StudioImagegenCandidateGateError(
      "candidate-path-mismatch",
      `候选路径必须精确等于 quarantine.candidatePath（got=${observed} expected=${expected}）。`,
    );
  }
  if (observed !== root && !observed.startsWith(rootWithSep)) {
    throw new StudioImagegenCandidateGateError(
      "candidate-outside-quarantine",
      `候选路径必须位于 quarantine root 内：${root}`,
    );
  }
  // 禁止用 sibling authority 图冒充：文件名必须是 candidate.png（或 grant 明示的 basename）
  const expectedBase = path.basename(expected);
  if (path.basename(observed) !== expectedBase) {
    throw new StudioImagegenCandidateGateError(
      "candidate-path-mismatch",
      `候选文件名必须为 ${expectedBase}。`,
    );
  }
  return observed;
}

/**
 * 在候选已存在于磁盘时验收大小；不存在则失败。
 * sizeBytes 由调用方 stat 后传入，便于单测不碰真实 FS。
 */
export function acceptStudioImagegenCandidateBytes(
  grant: StudioImagegenQuarantineGrant,
  observedPath: string,
  sizeBytes: number,
  options?: { minBytes?: number },
): StudioImagegenCandidateAcceptance {
  const candidatePath = assertStudioImagegenCandidatePathAllowed(grant, observedPath);
  const minBytes = options?.minBytes ?? 20_000;
  if (!Number.isFinite(sizeBytes) || sizeBytes < 0) {
    throw new StudioImagegenCandidateGateError("invalid-input", "sizeBytes 非法。");
  }
  if (sizeBytes === 0) {
    throw new StudioImagegenCandidateGateError("candidate-missing", `候选不存在或为空：${candidatePath}`);
  }
  if (sizeBytes < minBytes) {
    throw new StudioImagegenCandidateGateError(
      "candidate-too-small",
      `候选过小（${sizeBytes} < ${minBytes}）：${candidatePath}`,
    );
  }
  return { accepted: true, candidatePath, bytes: sizeBytes };
}

/**
 * 启发式搜索结果过滤器：只保留与 grant.candidatePath 相同的路径。
 * 其它 PNG（含 prop authority）一律丢弃。
 */
export function filterStudioImagegenCandidateSearchHits(
  grant: StudioImagegenQuarantineGrant,
  hits: readonly { path: string; size: number; mtime?: number }[],
): { path: string; size: number; mtime?: number } | null {
  const expected = normalizeAbs(grant.candidatePath, "grant.candidatePath");
  for (const hit of hits) {
    try {
      assertStudioImagegenCandidatePathAllowed(grant, hit.path);
      if (hit.size > 0) return { ...hit, path: expected };
    } catch {
      /* reject non-quarantine hits */
    }
  }
  return null;
}

/**
 * 构造 codex/agent 执行时应使用的 prompt 投递模式：
 * - prefer stdin（避免 CLI 参数吞 prompt）
 * - 可选同时写 prompt 文件作审计
 */
export function resolveStudioImagegenPromptDelivery(options: {
  promptText: string;
  promptFilePath?: string;
}): {
  mode: "stdin";
  promptText: string;
  promptFilePath?: string;
  argvPrompt: false;
} {
  const promptText = options.promptText?.trim() ?? "";
  if (!promptText) {
    throw new StudioImagegenCandidateGateError("invalid-input", "promptText 不能为空。");
  }
  return {
    mode: "stdin",
    promptText,
    ...(options.promptFilePath ? { promptFilePath: options.promptFilePath } : {}),
    argvPrompt: false,
  };
}
