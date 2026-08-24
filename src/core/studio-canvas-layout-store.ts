/**
 * 受管工程 sidecar 中的画布布局持久化。
 *
 * 路径：`.aicanvas/studio-canvas-layout.json`
 * - 仅视图层（坐标/视口/模式/固定节点/草稿边/工作流组 ID）
 * - 草稿边仅供视觉编排与 Start 预检，正式输入仍由 BindingSet/生成 owner 重建
 * - 不写入 panel 业务状态、SHA、媒体路径
 * - 仅 managed 工程；写入走项目锁 + 原子 JSON
 */
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import {
  inspectManagedProject,
  inspectManagedProjectReadOnly,
} from "./managed-project.js";
import { withProjectLock } from "./locks.js";
import { writeJsonAtomic } from "./sidecar.js";
import {
  mergeStudioCanvasLayout,
  normalizeStudioCanvasLayout,
  StudioCanvasLayoutError,
  type StudioCanvasLayout,
  type StudioCanvasLayoutDraft,
} from "./studio-canvas-layout.js";

export const STUDIO_CANVAS_LAYOUT_RELATIVE_PATH = ".aicanvas/studio-canvas-layout.json";
const LAYOUT_LOCK_NAME = "studio-canvas-layout";

export type StudioCanvasLayoutStoreErrorCode =
  | "unmanaged-project"
  | "layout-not-found"
  | "layout-corrupt"
  | "fingerprint-conflict"
  | "invalid-input"
  | "schema-unsupported";

export class StudioCanvasLayoutStoreError extends Error {
  readonly code: StudioCanvasLayoutStoreErrorCode;
  readonly details: string[];

  constructor(code: StudioCanvasLayoutStoreErrorCode, message: string, details: string[] = []) {
    super(message);
    this.name = "StudioCanvasLayoutStoreError";
    this.code = code;
    this.details = details;
  }
}

export interface SaveStudioCanvasLayoutInput {
  /** 完整替换（规范化后） */
  layout?: StudioCanvasLayoutDraft;
  /** 与现有合并；与 layout 二选一优先 patch */
  patch?: StudioCanvasLayoutDraft;
  /** 乐观并发：若提供则必须与磁盘 fingerprint 一致 */
  expectedFingerprint?: string;
}

export interface SaveStudioCanvasLayoutResult {
  layout: StudioCanvasLayout;
  relativePath: typeof STUDIO_CANVAS_LAYOUT_RELATIVE_PATH;
  created: boolean;
}

function layoutFilePath(projectRoot: string): string {
  return path.join(projectRoot, STUDIO_CANVAS_LAYOUT_RELATIVE_PATH);
}

async function assertManagedReadOnly(projectRoot: string): Promise<string> {
  try {
    const shell = await inspectManagedProjectReadOnly(projectRoot);
    return shell.paths.root;
  } catch (error) {
    throw new StudioCanvasLayoutStoreError(
      "unmanaged-project",
      "画布布局只允许从通过验证的受管工程读取。",
      [error instanceof Error ? error.message : String(error)],
    );
  }
}

async function assertManagedForWrite(projectRoot: string): Promise<string> {
  try {
    const shell = await inspectManagedProject(projectRoot);
    return shell.paths.root;
  } catch (error) {
    throw new StudioCanvasLayoutStoreError(
      "unmanaged-project",
      "画布布局只允许写入通过验证的受管工程。",
      [error instanceof Error ? error.message : String(error)],
    );
  }
}

function mapLayoutError(error: unknown): never {
  if (error instanceof StudioCanvasLayoutError) {
    throw new StudioCanvasLayoutStoreError(
      error.code === "schema-unsupported" ? "schema-unsupported" : "invalid-input",
      error.message,
      error.details,
    );
  }
  throw error;
}

function parseLayoutDocument(raw: string, filePath: string): StudioCanvasLayout {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new StudioCanvasLayoutStoreError(
      "layout-corrupt",
      `画布布局 JSON 损坏：${filePath}`,
      [error instanceof Error ? error.message : String(error)],
    );
  }
  if (!parsed || typeof parsed !== "object") {
    throw new StudioCanvasLayoutStoreError("layout-corrupt", `画布布局不是对象：${filePath}`);
  }
  const doc = parsed as Record<string, unknown>;
  try {
    const normalized = normalizeStudioCanvasLayout({
      viewport: doc.viewport as StudioCanvasLayout["viewport"],
      nodes: doc.nodes as StudioCanvasLayout["nodes"],
      workspaceMode: doc.workspaceMode as StudioCanvasLayout["workspaceMode"] | undefined,
      pinnedNodeIds: doc.pinnedNodeIds as StudioCanvasLayout["pinnedNodeIds"] | undefined,
      draftCanvasEdges: doc.draftCanvasEdges as StudioCanvasLayout["draftCanvasEdges"] | undefined,
      workflowGroups: doc.workflowGroups as StudioCanvasLayout["workflowGroups"],
      spatialGroups: doc.spatialGroups as StudioCanvasLayout["spatialGroups"],
      updatedAt: typeof doc.updatedAt === "string" ? doc.updatedAt : undefined,
    });
    // 磁盘 fingerprint 若与内容不一致，以内容为准重算（兼容手改）
    return normalized;
  } catch (error) {
    mapLayoutError(error);
  }
}

/** 读取布局；不存在返回 null（调用方可 autoLayout）。 */
export async function loadStudioCanvasLayout(projectRoot: string): Promise<StudioCanvasLayout | null> {
  const root = await assertManagedReadOnly(projectRoot);
  const filePath = layoutFilePath(root);
  try {
    await access(filePath);
  } catch {
    return null;
  }
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    throw new StudioCanvasLayoutStoreError(
      "layout-corrupt",
      `无法读取画布布局：${filePath}`,
      [error instanceof Error ? error.message : String(error)],
    );
  }
  return parseLayoutDocument(raw, filePath);
}

/**
 * 保存布局。默认 merge patch；提供 layout 且无 patch 时整表替换语义（仍经 normalize）。
 * expectedFingerprint 用于防止静默覆盖他人刚写入的布局。
 */
export async function saveStudioCanvasLayout(
  projectRoot: string,
  input: SaveStudioCanvasLayoutInput,
): Promise<SaveStudioCanvasLayoutResult> {
  const root = await assertManagedForWrite(projectRoot);
  if (!input.layout && !input.patch) {
    throw new StudioCanvasLayoutStoreError("invalid-input", "必须提供 layout 或 patch。");
  }

  return withProjectLock(root, LAYOUT_LOCK_NAME, async () => {
    const filePath = layoutFilePath(root);
    let existing: StudioCanvasLayout | null = null;
    let created = true;
    try {
      await access(filePath);
      created = false;
      existing = parseLayoutDocument(await readFile(filePath, "utf8"), filePath);
    } catch (error) {
      if (error instanceof StudioCanvasLayoutStoreError) throw error;
      // ENOENT → created
    }

    if (input.expectedFingerprint !== undefined) {
      const expected = input.expectedFingerprint.trim();
      if (!/^[a-f0-9]{64}$/u.test(expected)) {
        throw new StudioCanvasLayoutStoreError("invalid-input", "expectedFingerprint 必须是 64 位小写 hex。");
      }
      const current = existing?.fingerprint ?? null;
      if (current !== expected) {
        throw new StudioCanvasLayoutStoreError(
          "fingerprint-conflict",
          "画布布局 fingerprint 不匹配，拒绝覆盖。",
          [`expected=${expected}`, `current=${current ?? "(none)"}`],
        );
      }
    }

    let next: StudioCanvasLayout;
    try {
      if (input.patch) {
        next = mergeStudioCanvasLayout(existing, input.patch);
      } else {
        next = normalizeStudioCanvasLayout(input.layout!);
      }
    } catch (error) {
      mapLayoutError(error);
    }

    await writeJsonAtomic(filePath, next);
    return {
      layout: next,
      relativePath: STUDIO_CANVAS_LAYOUT_RELATIVE_PATH,
      created,
    };
  });
}

/** 删除布局文件（测试/重置视图用，不删业务数据）。 */
export async function clearStudioCanvasLayout(projectRoot: string): Promise<{ cleared: boolean }> {
  const root = await assertManagedForWrite(projectRoot);
  return withProjectLock(root, LAYOUT_LOCK_NAME, async () => {
    const filePath = layoutFilePath(root);
    try {
      await access(filePath);
    } catch {
      return { cleared: false };
    }
    const { rm } = await import("node:fs/promises");
    await rm(filePath, { force: true });
    return { cleared: true };
  });
}
