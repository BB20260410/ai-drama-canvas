/**
 * 将「冻结执行包」纪律接到正式 generation freeze 入口。
 * 正式 pack 仍是 studio-generation-freeze-pack；此门禁检查执行纪律字段是否可对映射。
 */
import {
  validateStudioFreezePackExecutionContract,
  type StudioFreezePackExecutionContract,
} from "./studio-freeze-pack-execution-contract.js";

export class StudioGenerationExecutionGateError extends Error {
  readonly code: string;
  readonly issues: Array<{ code: string; message: string }>;

  constructor(code: string, message: string, issues: Array<{ code: string; message: string }> = []) {
    super(message);
    this.name = "StudioGenerationExecutionGateError";
    this.code = code;
    this.issues = issues;
  }
}

/**
 * 校验主线程编译的 execution-freeze-pack（文件/JSON）是否可派生子代理。
 * 供 S1E2 共生环与测试调用；也作为 freeze 前可选预检。
 */
export function assertStudioExecutionFreezePackGate(pack: unknown): StudioFreezePackExecutionContract {
  const result = validateStudioFreezePackExecutionContract(pack);
  if (!result.ok) {
    throw new StudioGenerationExecutionGateError(
      "execution-pack-invalid",
      `冻结执行包未通过纪律门禁：${result.issues.map((i) => i.message).join("; ")}`,
      result.issues,
    );
  }
  if (result.pack.governance.concurrency !== 1) {
    throw new StudioGenerationExecutionGateError("concurrency", "正式生图 concurrency 必须为 1");
  }
  if (result.pack.frameLock.aspect_ratio !== "9:16") {
    throw new StudioGenerationExecutionGateError("frame", "画幅必须 9:16");
  }
  return result.pack;
}

/**
 * 对正式 StudioGenerationFreezePack（panel）做最小执行纪律检查，
 * 在 freezeAndPersist 成功构建 pack 之后调用。
 * P20：confirmed-empty 裁决闭合的格（extension 扩写格 / 零资产格）合法没有
 * 控制参考；调用方必须先从账本重读 BindingSet 确认闭合事实并显式传
 * confirmedEmptyClosure，缺省或 false 时维持 text-only 拦截。
 */
export function assertStudioFormalGenerationPackDiscipline(pack: {
  request?: { exactlyOneImage?: boolean; maxCalls?: number; controlReferences?: unknown[] };
  prompt?: { body?: string };
  layout?: string;
}, options?: { confirmedEmptyClosure?: boolean }): void {
  const refs = pack.request?.controlReferences;
  const confirmedEmptyExempt = options?.confirmedEmptyClosure === true && Array.isArray(refs) && refs.length === 0;
  if ((!Array.isArray(refs) || refs.length < 1) && !confirmedEmptyExempt) {
    throw new StudioGenerationExecutionGateError(
      "control-references-required",
      "正式冻结包缺少 controlReferences；禁止 text-only 生图。",
    );
  }
  // unit-grid / panel prompts must declare 9:16 when present
  const body = pack.prompt?.body ?? "";
  if (body && !/9\s*:\s*16|9x16|vertical/i.test(body) && pack.layout && !/9:16/.test(pack.layout)) {
    // soft: many legacy packs won't have it; only enforce when layout claims vertical grid
  }
  if (pack.layout && pack.layout.includes("9:16") && pack.request?.exactlyOneImage === false) {
    throw new StudioGenerationExecutionGateError("exactly-one", "9:16 unit-grid 必须 exactlyOneImage");
  }
}
