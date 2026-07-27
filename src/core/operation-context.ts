import { AsyncLocalStorage } from "node:async_hooks";

export interface OperationContext {
  requestId: string;
  idempotencyKey: string;
  requestHash: string;
  command: string;
}

const storage = new AsyncLocalStorage<OperationContext>();

export function runWithOperationContext<T>(context: OperationContext, work: () => Promise<T>): Promise<T> {
  return storage.run(context, work);
}

export function getOperationContext(): OperationContext | undefined {
  return storage.getStore();
}
