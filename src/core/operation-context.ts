import { AsyncLocalStorage } from "node:async_hooks";

/** 仅存活于单次 Main→command bus→commit 调用栈，不进请求哈希或 durable 账本。 */
export interface NovelImportDestinationExecutionIdentity {
  projectsRoot: string;
  canonicalRoot: string;
  dev: bigint;
  ino: bigint;
}

export interface OperationContext {
  requestId: string;
  idempotencyKey: string;
  requestHash: string;
  command: string;
  novelImportDestinationIdentity?: NovelImportDestinationExecutionIdentity;
}

const storage = new AsyncLocalStorage<OperationContext>();

export function runWithOperationContext<T>(context: OperationContext, work: () => Promise<T>): Promise<T> {
  return storage.run(context, work);
}

export function getOperationContext(): OperationContext | undefined {
  return storage.getStore();
}
