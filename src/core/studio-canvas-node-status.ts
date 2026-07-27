/**
 * 画布节点运行状态（视图层，clean-room 对齐 LocalMiniDrama useCanvasNodeStatus）。
 * - 不读写 SQLite/CAS；仅会话态投影
 * - 供 ManagedStudioCanvas overlay 与测试共用
 */
export type StudioCanvasNodeStatusStep =
  | "image"
  | "video"
  | "audio"
  | "review"
  | "freeze"
  | "dispatch"
  | "workflow"
  | "save"
  | "busy";

export interface StudioCanvasNodeStatus {
  step: StudioCanvasNodeStatusStep | string;
  message: string;
  at: number;
}

export const STUDIO_CANVAS_NODE_STATUS_LABELS: Readonly<Record<string, string>> = {
  image: "生图中",
  video: "生视频中",
  audio: "配音中",
  review: "Review 中",
  freeze: "冻结包中",
  dispatch: "派发中",
  workflow: "工作流执行中",
  save: "保存中",
  busy: "处理中…",
};

export interface StudioCanvasNodeStatusStore {
  set(nodeId: string, payload: { step?: string; message?: string } | null): void;
  clear(nodeId: string): void;
  get(nodeId: string): StudioCanvasNodeStatus | null;
  isBusy(nodeId: string): boolean;
  /** 只读快照（测试/序列化） */
  snapshot(): Record<string, StudioCanvasNodeStatus>;
}

export function createStudioCanvasNodeStatusStore(): StudioCanvasNodeStatusStore {
  const map = new Map<string, StudioCanvasNodeStatus>();

  return {
    set(nodeId, payload) {
      const id = nodeId.trim();
      if (!id) return;
      if (!payload) {
        map.delete(id);
        return;
      }
      const step = (payload.step ?? "busy").trim() || "busy";
      const message = (payload.message ?? STUDIO_CANVAS_NODE_STATUS_LABELS[step] ?? "处理中…").trim()
        || "处理中…";
      map.set(id, { step, message, at: Date.now() });
    },
    clear(nodeId) {
      const id = nodeId.trim();
      if (id) map.delete(id);
    },
    get(nodeId) {
      const id = nodeId.trim();
      return id ? map.get(id) ?? null : null;
    },
    isBusy(nodeId) {
      return this.get(nodeId) != null;
    },
    snapshot() {
      return Object.fromEntries([...map.entries()].sort(([a], [b]) => a.localeCompare(b)));
    },
  };
}

export function labelForStudioCanvasNodeStatusStep(step: string): string {
  return STUDIO_CANVAS_NODE_STATUS_LABELS[step] ?? step;
}
