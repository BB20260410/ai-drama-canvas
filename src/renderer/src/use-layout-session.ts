/**
 * Qwen D2 · 布局会话（防 thrash 的 generation + debounce 调度）
 *
 * 抽出画布布局落盘会话语义：pending → saving → saved/error；
 * generation 失效旧保存；不推导 nextAction。
 */

export type LayoutSessionState = "idle" | "pending" | "saving" | "saved" | "error";

export interface LayoutSession {
  readonly state: LayoutSessionState;
  readonly generation: number;
  schedule(projectRoot: string, persist: (generation: number, projectRoot: string) => Promise<void>, delayMs?: number): void;
  cancel(): void;
  isCurrent(generation: number, projectRoot: string, activeProjectRoot: string): boolean;
  markSaving(generation: number, projectRoot: string, activeProjectRoot: string): boolean;
  markSaved(generation: number, projectRoot: string, activeProjectRoot: string): void;
  markError(generation: number, projectRoot: string, activeProjectRoot: string): void;
  statusLabel(): string;
}

export function createLayoutSession(): LayoutSession {
  let state: LayoutSessionState = "idle";
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<void> | undefined;

  const api: LayoutSession = {
    get state() {
      return state;
    },
    get generation() {
      return generation;
    },
    schedule(projectRoot, persist, delayMs = 450) {
      state = "pending";
      if (timer) clearTimeout(timer);
      const gen = ++generation;
      timer = setTimeout(() => {
        timer = undefined;
        const op = persist(gen, projectRoot);
        inFlight = op;
        void op.finally(() => {
          if (inFlight === op) inFlight = undefined;
        });
      }, delayMs);
    },
    cancel() {
      if (timer) clearTimeout(timer);
      timer = undefined;
      generation += 1;
      state = "idle";
    },
    isCurrent(gen, projectRoot, activeProjectRoot) {
      return gen === generation && projectRoot === activeProjectRoot;
    },
    markSaving(gen, projectRoot, activeProjectRoot) {
      if (!api.isCurrent(gen, projectRoot, activeProjectRoot)) return false;
      state = "saving";
      return true;
    },
    markSaved(gen, projectRoot, activeProjectRoot) {
      if (!api.isCurrent(gen, projectRoot, activeProjectRoot)) return;
      state = "saved";
    },
    markError(gen, projectRoot, activeProjectRoot) {
      if (!api.isCurrent(gen, projectRoot, activeProjectRoot)) return;
      state = "error";
    },
    statusLabel() {
      if (state === "pending") return "布局待保存";
      if (state === "saving") return "布局保存中";
      if (state === "saved") return "布局已落盘";
      if (state === "error") return "布局保存失败";
      return "布局空闲";
    },
  };
  return api;
}
