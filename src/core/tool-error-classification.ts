/**
 * MCP/GUI 共用的命令错误码纯分类器（从 src/mcp/server.ts 的 toolError 抽取，
 * 供单测直接覆盖；server.ts 因顶层连接 stdio transport 无法被测试直接 import）。
 *
 * 既有分支（cancelled/conflict/notFound/permission/external）正则与文案保持
 * 逐字不变；本次新增两条此前缺失的分类：
 * - outcomeUnknown：副作用可能已提交但响应丢失。必须优先于 busy/conflict，
 *   强制调用方先经 reconcile_command / operation receipt 对账，禁止盲目重放。
 * - busy：SQLITE_BUSY/SQLITE_LOCKED（含 "database is locked"）是资源瞬时锁，
 *   不是输入校验错误；映射 RESOURCE_BUSY 且 retryable=true，并优先于 conflict
 *   （错误文案可能同时命中"写锁"等冲突关键词）。
 */
export type ToolErrorCode =
  | "CANCELLED"
  | "OUTCOME_UNKNOWN"
  | "RESOURCE_BUSY"
  | "CONFLICT"
  | "NOT_FOUND"
  | "PERMISSION_DENIED"
  | "EXTERNAL_FAILURE"
  | "VALIDATION_ERROR";

export interface ToolErrorClassification {
  code: ToolErrorCode;
  retryable: boolean;
  suggestedAction: string;
  /** 原始命中标记，供结构化响应补充 applied/outcome 等字段 */
  outcomeUnknown: boolean;
  busy: boolean;
}

export function classifyToolError(input: { message: string; cancelled: boolean }): ToolErrorClassification {
  const { message, cancelled } = input;
  const outcomeUnknown = /命令执行结果未确认|禁止自动重放|保持 unknown|未能从不可变/.test(message);
  const busy = /database is locked|database table is locked|SQLITE_BUSY|SQLITE_LOCKED/i.test(message);
  const conflict = /修订|\brevision\b|\bCAS\b|其他窗口|幂等键|requestId 已用于|重复|写锁|等待超过/i.test(message);
  const notFound = /找不到|不存在|尚未物化/.test(message);
  const permission = /权限|不可写|不在项目允许/.test(message);
  const external = /HTTP|供应商|网页|FFmpeg|FFprobe|下载|远端/.test(message);
  const code: ToolErrorCode = cancelled
    ? "CANCELLED"
    : outcomeUnknown
      ? "OUTCOME_UNKNOWN"
      : busy
        ? "RESOURCE_BUSY"
        : conflict
          ? "CONFLICT"
          : notFound
            ? "NOT_FOUND"
            : permission
              ? "PERMISSION_DENIED"
              : external
                ? "EXTERNAL_FAILURE"
                : "VALIDATION_ERROR";
  const retryable = !cancelled && !outcomeUnknown && (busy || conflict || external);
  const suggestedAction = cancelled
    ? "扫描未越过提交点；如需重新扫描，请使用新的 requestId 与 idempotencyKey。"
    : outcomeUnknown
      ? "副作用可能已提交但响应丢失：先用 reconcile_command 读取同一 idempotencyKey 的 operation receipt 对账；对账成功前禁止重放、禁止更换参数重发。"
      : busy
        ? "数据库瞬时锁：受控重试预算内未释放且事务未提交；使用相同的 requestId 与 idempotencyKey 重试，不要新建键或并发另发。"
        : conflict
          ? "重新读取当前修订或任务状态；不要复用不同参数的幂等键。"
          : notFound
            ? "先读取项目快照并核对稳定 ID 与真实路径。"
            : permission
              ? "核对项目允许输出根和目录权限。"
              : external
                ? "检查外部服务、登录态、任务 ID和本地落盘，再从检查点恢复。"
                : "修正输入后重试；不要绕过门禁。";
  return { code, retryable, suggestedAction, outcomeUnknown, busy };
}
