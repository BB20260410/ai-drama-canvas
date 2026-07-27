import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  STUDIO_SQLITE_BUSY_RETRY_BUDGET_MS,
  STUDIO_SQLITE_BUSY_RETRY_MAX_ATTEMPTS,
  STUDIO_SQLITE_READ_BUSY_TIMEOUT_MS,
  STUDIO_SQLITE_WRITE_BUSY_TIMEOUT_MS,
  isSqliteBusyError,
  sqliteBusyDetailMessage,
  withSqliteBusyRetry,
} from "../src/core/studio-sqlite-busy.js";
import { classifyToolError } from "../src/core/tool-error-classification.js";
import { executeIdempotentCommand, listCommandLedger, reconcileCommand } from "../src/core/command-bus.js";
import { scanAndPersist } from "../src/core/service.js";
import { ensureSidecar, getSidecarPaths, listTaskPacks, writeJsonAtomic } from "../src/core/sidecar.js";
import { seedProductionReady } from "./workflow-helpers.js";

const roots: string[] = [];

afterEach(async () => {
  delete process.env.AI_CANVAS_TEST_COMMAND_BUSY_COMMAND;
  delete process.env.AI_CANVAS_TEST_COMMAND_BUSY_EXECUTE_TIMES;
  delete process.env.AI_CANVAS_TEST_COMMAND_BUSY_AFTER_EXECUTE;
  delete process.env.AI_CANVAS_TEST_COMMAND_DELAY_COMMAND;
  delete process.env.AI_CANVAS_TEST_COMMAND_DELAY_MS;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

// 与 tests/command-bus.test.ts 相同的幂等命令夹具：main-ep01-unit001 可供 create_task_pack。
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "ai-canvas-sqlite-busy-"));
  roots.push(root);
  const config = await ensureSidecar(root);
  config.sourceRoots = [];
  config.outputRoots = [root];
  await writeJsonAtomic(getSidecarPaths(root).config, config);
  const directory = path.join(root, "EP01_15s_001_幂等测试");
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "00_信息.md"), "首帧提示词：幂等测试。\n尾帧提示词：保持连续。\n", "utf8");
  await scanAndPersist(root);
  await seedProductionReady(root, "frames");
  return root;
}

function taskPackInput(requestId: string, idempotencyKey: string) {
  return {
    requestId,
    idempotencyKey,
    request: { command: "create_task_pack" as const, payload: { itemIds: ["main-ep01-unit001"], mode: "autopilot" as const, kind: "image" as const } },
  };
}

describe("studio-sqlite-busy", () => {
  it("写路径 timeout ≥ 60s", () => {
    expect(STUDIO_SQLITE_WRITE_BUSY_TIMEOUT_MS).toBeGreaterThanOrEqual(60_000);
  });

  it("读路径 timeout 正且 ≤ 写路径", () => {
    expect(STUDIO_SQLITE_READ_BUSY_TIMEOUT_MS).toBeGreaterThan(0);
    expect(STUDIO_SQLITE_READ_BUSY_TIMEOUT_MS).toBeLessThanOrEqual(STUDIO_SQLITE_WRITE_BUSY_TIMEOUT_MS);
  });

  it("isSqliteBusyError 识别 errcode/message/cause 链，且不吞普通错误", () => {
    expect(isSqliteBusyError(Object.assign(new Error("whatever"), { errcode: 5 }))).toBe(true);
    expect(isSqliteBusyError(Object.assign(new Error("whatever"), { errcode: 6 }))).toBe(true);
    expect(isSqliteBusyError(new Error("database is locked"))).toBe(true);
    expect(isSqliteBusyError(new Error("SQLITE_BUSY: unable to acquire"))).toBe(true);
    expect(isSqliteBusyError(new Error("包装", { cause: new Error("database is locked") }))).toBe(true);
    expect(isSqliteBusyError(new Error("修订冲突，请刷新"))).toBe(false);
    expect(isSqliteBusyError("database is locked")).toBe(false);
    expect(isSqliteBusyError(undefined)).toBe(false);
  });

  it("withSqliteBusyRetry 有界：busy 打满 maxAttempts 后抛出，非 busy 不重试", async () => {
    let busyCalls = 0;
    await expect(withSqliteBusyRetry(() => {
      busyCalls += 1;
      return Promise.reject(new Error("database is locked"));
    })).rejects.toThrow("database is locked");
    expect(busyCalls).toBe(STUDIO_SQLITE_BUSY_RETRY_MAX_ATTEMPTS);

    let otherCalls = 0;
    await expect(withSqliteBusyRetry(() => {
      otherCalls += 1;
      return Promise.reject(new Error("schema 合同无效"));
    })).rejects.toThrow("schema 合同无效");
    expect(otherCalls).toBe(1);

    let eventualCalls = 0;
    const value = await withSqliteBusyRetry(() => {
      eventualCalls += 1;
      return eventualCalls < 3 ? Promise.reject(new Error("database is locked")) : Promise.resolve("ok");
    });
    expect(value).toBe("ok");
    expect(eventualCalls).toBe(3);
  });

  it("busy-before-transaction：受控退避后成功，副作用只产生一次", async () => {
    const root = await fixture();
    process.env.AI_CANVAS_TEST_COMMAND_BUSY_COMMAND = "create_task_pack";
    process.env.AI_CANVAS_TEST_COMMAND_BUSY_EXECUTE_TIMES = "2";
    const input = taskPackInput("request-busy-before-001", "taskpack-busy-before-unit001-v1");
    const startedAt = Date.now();
    const record = await executeIdempotentCommand(root, input);
    expect(record.status).toBe("succeeded");
    // 两次注入 busy → 至少两轮指数退避（120/240ms 基线），未突破 ≤5s 预算。
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(200);
    expect(Date.now() - startedAt).toBeLessThan(STUDIO_SQLITE_BUSY_RETRY_BUDGET_MS + 5_000);
    // 只产生一次副作用、一个账本键。
    expect(await listTaskPacks(root)).toHaveLength(1);
    const ledger = await listCommandLedger(root);
    expect(ledger.filter((entry) => entry.idempotencyKey === input.idempotencyKey)).toHaveLength(1);
    // 同键重放直接返回原结果，不再执行。
    const replayed = await executeIdempotentCommand(root, { ...input, requestId: "request-busy-before-002" });
    expect(replayed.replayed).toBe(true);
    expect(await listTaskPacks(root)).toHaveLength(1);
  });

  it("busy-during-commit：重试预算耗尽后分类 RESOURCE_BUSY/retryable=true，绝不 VALIDATION_ERROR；同键受控重试放行", async () => {
    const root = await fixture();
    process.env.AI_CANVAS_TEST_COMMAND_BUSY_COMMAND = "create_task_pack";
    process.env.AI_CANVAS_TEST_COMMAND_BUSY_EXECUTE_TIMES = "12"; // 超过 maxAttempts，预算内必败
    const input = taskPackInput("request-busy-commit-001", "taskpack-busy-commit-unit001-v1");
    const failure: unknown = await executeIdempotentCommand(root, input).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    const message = (failure as Error).message;
    expect(message).toContain("database is locked");
    expect(message).toContain("受控重试");
    expect(message).toContain("事务未提交");
    // MCP 错误码映射（toolError 同款分类器）：必须 RESOURCE_BUSY 且可重试，绝不误标 VALIDATION_ERROR。
    const classification = classifyToolError({ message, cancelled: false });
    expect(classification.code).toBe("RESOURCE_BUSY");
    expect(classification.code).not.toBe("VALIDATION_ERROR");
    expect(classification.retryable).toBe(true);
    // 账本落 failed(busyUncommitted) 而非 unknown：事务确认未提交，次数留账。
    const ledger = await listCommandLedger(root);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]?.status).toBe("failed");
    const ledgerError = ledger[0]?.error as { busyUncommitted?: boolean; attempts?: number; retryBudgetMs?: number } | undefined;
    expect(ledgerError?.busyUncommitted).toBe(true);
    expect(ledgerError?.attempts).toBe(STUDIO_SQLITE_BUSY_RETRY_MAX_ATTEMPTS);
    expect(ledgerError?.retryBudgetMs).toBe(STUDIO_SQLITE_BUSY_RETRY_BUDGET_MS);
    expect(await listTaskPacks(root)).toHaveLength(0);
    // 锁释放后同一 idempotencyKey（新 requestId）受控重试：放行并成功，副作用仍只一次。
    delete process.env.AI_CANVAS_TEST_COMMAND_BUSY_COMMAND;
    delete process.env.AI_CANVAS_TEST_COMMAND_BUSY_EXECUTE_TIMES;
    const retried = await executeIdempotentCommand(root, { ...input, requestId: "request-busy-commit-002" });
    expect(retried.status).toBe("succeeded");
    expect(await listTaskPacks(root)).toHaveLength(1);
    expect((await listCommandLedger(root)).filter((entry) => entry.idempotencyKey === input.idempotencyKey)).toHaveLength(1);
  });

  it("response-lost-after-commit：busy 落入 outcome_unknown/receipt 对账路径，不重复提交", async () => {
    const root = await fixture();
    process.env.AI_CANVAS_TEST_COMMAND_BUSY_AFTER_EXECUTE = "create_task_pack";
    const input = taskPackInput("request-busy-lost-001", "taskpack-busy-lost-unit001-v1");
    const failure: unknown = await executeIdempotentCommand(root, input).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    const message = (failure as Error).message;
    expect(message).toContain("结果未确认");
    // outcome_unknown 必须优先于 busy：强制先对账，retryable=false，绝不误标 VALIDATION_ERROR。
    const classification = classifyToolError({ message, cancelled: false });
    expect(classification.code).toBe("OUTCOME_UNKNOWN");
    expect(classification.code).not.toBe("VALIDATION_ERROR");
    expect(classification.retryable).toBe(false);
    // 副作用已提交且仅一次；账本锁 unknown。
    expect((await listCommandLedger(root))[0]?.status).toBe("unknown");
    expect(await listTaskPacks(root)).toHaveLength(1);
    delete process.env.AI_CANVAS_TEST_COMMAND_BUSY_AFTER_EXECUTE;
    // 禁止自动重放：同键重试不重复执行。
    await expect(executeIdempotentCommand(root, { ...input, requestId: "request-busy-lost-002" })).rejects.toThrow("禁止自动重放");
    expect(await listTaskPacks(root)).toHaveLength(1);
    // receipt/reconcile 对账（复用 command-bus 既有机制）：side-effect-committed 证据 → succeeded。
    const reconciled = await reconcileCommand(root, { idempotencyKey: input.idempotencyKey });
    expect(reconciled.status).toBe("succeeded");
    // 对账后同键重放返回原结果，仍不产生新副作用。
    const replayed = await executeIdempotentCommand(root, { ...input, requestId: "request-busy-lost-003" });
    expect(replayed.replayed).toBe(true);
    expect(await listTaskPacks(root)).toHaveLength(1);
  });

  it("AggregateError 包裹 busy（withFileLock 双失败形态）：识别为 busy，细节文案稳定分类 RESOURCE_BUSY", () => {
    const busy = Object.assign(new Error("database is locked"), { errcode: 5 });
    const cleanup = new Error("项目写锁 studio-mutation ownership 已丢失，已保留替换节点。");
    const aggregate = new AggregateError([busy, cleanup], "项目写锁 studio-mutation 临界区与释放均失败。");
    // 漏识别会落入 unknown 路径（保守但分类失真）；修复后 errors 数组浅查一层命中。
    expect(isSqliteBusyError(aggregate)).toBe(true);
    // 不含 busy 的 AggregateError 不误判；busy 嵌套超过一层（深度限 1 层）不递归识别。
    expect(isSqliteBusyError(new AggregateError([new Error("修订冲突"), cleanup], "均失败"))).toBe(false);
    expect(isSqliteBusyError(new AggregateError([new AggregateError([busy], "nested")], "outer"))).toBe(false);
    // AggregateError 自身 message 不含 busy 文案；细节文案须取首个 busy 成员，
    // 否则 command-bus busy 分支组合的抛出文案无法命中 RESOURCE_BUSY 文本分类。
    expect(sqliteBusyDetailMessage(aggregate)).toBe("database is locked");
    expect(sqliteBusyDetailMessage(busy)).toBe("database is locked");
    const surfaced = `数据库瞬时锁在 ${STUDIO_SQLITE_BUSY_RETRY_MAX_ATTEMPTS} 次受控重试（预算 ${STUDIO_SQLITE_BUSY_RETRY_BUDGET_MS}ms）后仍未释放（command=create_task_pack，事务未提交）：${sqliteBusyDetailMessage(aggregate)}`;
    const classification = classifyToolError({ message: surfaced, cancelled: false });
    expect(classification.code).toBe("RESOURCE_BUSY");
    expect(classification.retryable).toBe(true);
    expect(classification.code).not.toBe("VALIDATION_ERROR");
  });

  it("AggregateError 包裹 busy：withSqliteBusyRetry 受控重试后成功，副作用只产生一次", async () => {
    const aggregate = () => new AggregateError(
      [Object.assign(new Error("database is locked"), { errcode: 5 }), new Error("锁释放失败")],
      "临界区与释放均失败。",
    );
    let calls = 0;
    const value = await withSqliteBusyRetry(() => {
      calls += 1;
      return calls < 3 ? Promise.reject(aggregate()) : Promise.resolve("ok");
    });
    expect(value).toBe("ok");
    expect(calls).toBe(3);
    // 打满 maxAttempts 后原样抛出最后一次错误，且仍被识别为 busy。
    let failCalls = 0;
    const failure: unknown = await withSqliteBusyRetry(() => {
      failCalls += 1;
      return Promise.reject(aggregate());
    }).catch((error: unknown) => error);
    expect(failCalls).toBe(STUDIO_SQLITE_BUSY_RETRY_MAX_ATTEMPTS);
    expect(isSqliteBusyError(failure)).toBe(true);
  });

  it("wait 分支目击 busyUncommitted 失败记录：结构化标记 + 稳定 RESOURCE_BUSY，不自动重登记", async () => {
    const root = await fixture();
    // 首调用：每次执行前延迟 300ms 留出 wait 窗口，busy 注入 12 次（>maxAttempts，预算内必败）。
    process.env.AI_CANVAS_TEST_COMMAND_DELAY_COMMAND = "create_task_pack";
    process.env.AI_CANVAS_TEST_COMMAND_DELAY_MS = "300";
    process.env.AI_CANVAS_TEST_COMMAND_BUSY_COMMAND = "create_task_pack";
    process.env.AI_CANVAS_TEST_COMMAND_BUSY_EXECUTE_TIMES = "12";
    const input = taskPackInput("request-busy-wait-001", "taskpack-busy-wait-unit001-v1");
    const first = executeIdempotentCommand(root, input);
    // 等首调用的 running 记录落账（登记完成）后再发同键等待者，避免与其竞争登记先后。
    for (let i = 0; i < 300; i += 1) {
      const ledger = await listCommandLedger(root);
      if (ledger.some((entry) => entry.idempotencyKey === input.idempotencyKey && entry.status === "running")) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const second: unknown = await executeIdempotentCommand(root, { ...input, requestId: "request-busy-wait-002" })
      .catch((error: unknown) => error);
    const firstFailure: unknown = await first.catch((error: unknown) => error);
    expect(firstFailure).toBeInstanceOf(Error);
    // wait 分支抛出结构化 busy 错误：对象标记 + 文本双通道稳定命中 RESOURCE_BUSY。
    expect(second).toBeInstanceOf(Error);
    const waitError = second as Error & { busyUncommitted?: boolean; retryable?: boolean };
    expect(waitError.busyUncommitted).toBe(true);
    expect(waitError.retryable).toBe(true);
    expect(waitError.message).toContain("事务未提交");
    const classification = classifyToolError({ message: waitError.message, cancelled: false });
    expect(classification.code).toBe("RESOURCE_BUSY");
    expect(classification.retryable).toBe(true);
    expect(classification.code).not.toBe("VALIDATION_ERROR");
    // 登记语义不变：账本仍只有一条 failed(busyUncommitted)，wait 分支未自动重登记。
    const ledger = await listCommandLedger(root);
    expect(ledger.filter((entry) => entry.idempotencyKey === input.idempotencyKey)).toHaveLength(1);
    expect(ledger[0]?.status).toBe("failed");
    expect((ledger[0]?.error as { busyUncommitted?: boolean } | undefined)?.busyUncommitted).toBe(true);
    expect(await listTaskPacks(root)).toHaveLength(0);
    // 调用方按提示用相同 idempotencyKey（新 requestId）重发：登记分支放行，副作用只一次。
    delete process.env.AI_CANVAS_TEST_COMMAND_DELAY_COMMAND;
    delete process.env.AI_CANVAS_TEST_COMMAND_DELAY_MS;
    delete process.env.AI_CANVAS_TEST_COMMAND_BUSY_COMMAND;
    delete process.env.AI_CANVAS_TEST_COMMAND_BUSY_EXECUTE_TIMES;
    const retried = await executeIdempotentCommand(root, { ...input, requestId: "request-busy-wait-003" });
    expect(retried.status).toBe("succeeded");
    expect(await listTaskPacks(root)).toHaveLength(1);
    expect((await listCommandLedger(root)).filter((entry) => entry.idempotencyKey === input.idempotencyKey)).toHaveLength(1);
  });
});
