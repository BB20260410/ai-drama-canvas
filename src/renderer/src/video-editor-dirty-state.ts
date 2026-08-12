import type { EditProject } from "../../core/types.js";

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right, "en"))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return value === undefined ? "null" : (JSON.stringify(value) ?? "null");
}

export function captureVideoEditorDraftBaseline(project: EditProject | null): string {
  return project ? stableJson(project) : "";
}

export function hasUnsavedVideoEditorDraft(project: EditProject | null, baseline: string): boolean {
  return Boolean(project) && captureVideoEditorDraftBaseline(project) !== baseline;
}

export interface VideoEditorLoadToken {
  projectRoot: string;
  generation: number;
}

export function createVideoEditorLoadGate(): {
  begin(projectRoot: string): VideoEditorLoadToken;
  invalidate(): void;
  isCurrent(token: VideoEditorLoadToken): boolean;
} {
  let generation = 0;
  return {
    begin(projectRoot) {
      generation += 1;
      return { projectRoot, generation };
    },
    invalidate() {
      generation += 1;
    },
    isCurrent(token) {
      return token.generation === generation;
    },
  };
}

/**
 * 同一组件内的媒体列表请求采用 latest-wins。扫描通知可能比首载更晚发出却
 * 更早返回；旧请求的成功或失败都不能覆盖/干扰更新的列表。
 */
export function createLatestVideoEditorMediaLoader<T, Request = string>(
  request: (input: Request) => Promise<T>,
  accept: (value: T, input: Request) => void,
): {
  load(input: Request): Promise<boolean>;
  invalidate(): void;
} {
  let generation = 0;
  return {
    async load(input) {
      const requestGeneration = ++generation;
      try {
        const value = await request(input);
        if (requestGeneration !== generation) return false;
        accept(value, input);
        return true;
      } catch (error) {
        if (requestGeneration !== generation) return false;
        throw error;
      }
    },
    invalidate() {
      generation += 1;
    },
  };
}
