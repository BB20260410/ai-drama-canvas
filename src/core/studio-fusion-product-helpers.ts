/**
 * 产品接线用融合助手：把合同层能力收成单一 operation 入口，供 MCP 只读调用。
 * 不写 CAS；execute compose 由专用函数路径执行。
 */

import { createStudioAgentToolFactory } from "./studio-agent-tool-factory.js";
import { validateBindingScope } from "./studio-binding-scope.js";
import { planExplicitElementBind } from "./studio-elements-bind.js";
import {
  createStudioStagingArea,
  decideStudioStagingItem,
  listPendingStudioStaging,
  stageGenerationResult,
  type StudioStagingArea,
} from "./studio-generation-staging.js";
import { validateStudioPanelJsonArray } from "./studio-panel-json-contract.js";
import { planStudioShotCompose, type StudioShotComposeInput } from "./studio-shot-compose.js";
import { intercalateShotNumber, nextShotNumber } from "./studio-shot-numbering.js";
import { validateStudioShotDraft } from "./studio-shot-schema.js";
import { validateStudioVideoPrompt } from "./studio-video-prompt-segments.js";
import { publicationPreflightLocal } from "./studio-fusion-p5-p9.js";
import { planStudioGridSplit, mapGridSplitToPanelOrdinals } from "./studio-grid-split.js";

export type FusionHelperOperation =
  | "shot-compose-plan"
  | "element-bind"
  | "video-prompt"
  | "shot-draft"
  | "shot-number-intercalate"
  | "shot-number-next"
  | "binding-scope"
  | "panel-json"
  | "grid-split"
  | "tool-factory"
  | "staging-demo"
  | "publication-preflight";

export type FusionHelperRequest = {
  operation: FusionHelperOperation;
  payload?: Record<string, unknown>;
};

export type FusionHelperResponse = {
  kind: "studio-fusion-helper-result";
  schemaVersion: 1;
  operation: FusionHelperOperation;
  ok: boolean;
  result?: unknown;
  error?: string;
};

function asString(v: unknown, name: string): string {
  if (typeof v !== "string" || !v.trim()) throw new Error(`${name} 须为非空字符串`);
  return v.trim();
}

function asNumber(v: unknown, name: string): number {
  if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`${name} 须为有限数字`);
  return v;
}

function asPositiveInt(v: unknown, name: string): number {
  const n = asNumber(v, name);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} 须为正整数`);
  return n;
}

/** 无 I/O 的助手（staging-demo 使用请求内嵌状态机一轮） */
export function runStudioFusionHelper(req: FusionHelperRequest): FusionHelperResponse {
  try {
    const op = req.operation;
    const p = req.payload ?? {};
    switch (op) {
      case "shot-compose-plan": {
        const plan = planStudioShotCompose(p as StudioShotComposeInput);
        return {
          kind: "studio-fusion-helper-result",
          schemaVersion: 1,
          operation: op,
          ok: plan.readyForFfmpeg,
          result: plan,
          error: plan.readyForFfmpeg ? undefined : plan.blockers.join("; "),
        };
      }
      case "element-bind": {
        const result = planExplicitElementBind({
          panelId: asString(p.panelId, "panelId"),
          assetId: asString(p.assetId, "assetId"),
          allowedAssetIds: Array.isArray(p.allowedAssetIds) ? (p.allowedAssetIds as string[]) : [],
          expectedKind: p.expectedKind as "character" | "scene" | "prop" | undefined,
          ambiguousContext: Boolean(p.ambiguousContext),
          entityText: typeof p.entityText === "string" ? p.entityText : undefined,
        });
        return { kind: "studio-fusion-helper-result", schemaVersion: 1, operation: op, ok: result.kind === "bind", result };
      }
      case "video-prompt": {
        const result = validateStudioVideoPrompt(asString(p.videoPrompt, "videoPrompt"), {
          maxDurationSeconds: typeof p.maxDurationSeconds === "number" ? p.maxDurationSeconds : 15,
        });
        return { kind: "studio-fusion-helper-result", schemaVersion: 1, operation: op, ok: result.ok, result };
      }
      case "shot-draft": {
        const result = validateStudioShotDraft(p as never, {
          requireVideoPromptSegments: Boolean(p.requireVideoPromptSegments),
        });
        return { kind: "studio-fusion-helper-result", schemaVersion: 1, operation: op, ok: result.ok, result };
      }
      case "shot-number-intercalate": {
        const n = intercalateShotNumber(
          p.before === null || p.before === undefined ? null : asNumber(p.before, "before"),
          p.after === null || p.after === undefined ? null : asNumber(p.after, "after"),
          typeof p.step === "number" ? p.step : 10,
        );
        return { kind: "studio-fusion-helper-result", schemaVersion: 1, operation: op, ok: true, result: { number: n } };
      }
      case "shot-number-next": {
        const existing = Array.isArray(p.existing) ? (p.existing as number[]) : [];
        return {
          kind: "studio-fusion-helper-result",
          schemaVersion: 1,
          operation: op,
          ok: true,
          result: { number: nextShotNumber(existing, typeof p.step === "number" ? p.step : 10) },
        };
      }
      case "binding-scope": {
        const result = validateBindingScope({
          unitId: asString(p.unitId, "unitId"),
          allowedCharacterIds: (p.allowedCharacterIds as string[]) ?? [],
          allowedSceneIds: (p.allowedSceneIds as string[]) ?? [],
          bindCharacterIds: (p.bindCharacterIds as string[]) ?? [],
          bindSceneIds: (p.bindSceneIds as string[]) ?? [],
        });
        return { kind: "studio-fusion-helper-result", schemaVersion: 1, operation: op, ok: result.ok, result };
      }
      case "panel-json": {
        const result = validateStudioPanelJsonArray(p.panels);
        return { kind: "studio-fusion-helper-result", schemaVersion: 1, operation: op, ok: result.ok, result };
      }
      case "grid-split": {
        const plan = planStudioGridSplit({
          imageWidth: asPositiveInt(p.imageWidth, "imageWidth"),
          imageHeight: asPositiveInt(p.imageHeight, "imageHeight"),
          rows: asPositiveInt(p.rows, "rows"),
          cols: asPositiveInt(p.cols, "cols"),
        });
        const ordinals = Array.isArray(p.panelOrdinals)
          ? (p.panelOrdinals as number[])
          : plan.cells.map((_, i) => i + 1);
        const mapped = mapGridSplitToPanelOrdinals(plan, ordinals.slice(0, plan.cells.length));
        return { kind: "studio-fusion-helper-result", schemaVersion: 1, operation: op, ok: true, result: { plan, mapped } };
      }
      case "tool-factory": {
        const factory = createStudioAgentToolFactory({
          unitId: asString(p.unitId, "unitId"),
          episodeId: asString(p.episodeId, "episodeId"),
          allowedCharacterIds: (p.allowedCharacterIds as string[]) ?? [],
          allowedSceneIds: (p.allowedSceneIds as string[]) ?? [],
        });
        return {
          kind: "studio-fusion-helper-result",
          schemaVersion: 1,
          operation: op,
          ok: true,
          result: { toolIds: factory.tools.map((t) => t.id), context: factory.context },
        };
      }
      case "staging-demo": {
        let area: StudioStagingArea = createStudioStagingArea();
        area = stageGenerationResult(area, {
          id: asString(p.id ?? "demo", "id"),
          panelId: asString(p.panelId ?? "panel-1", "panelId"),
          runId: asString(p.runId ?? "run-1", "runId"),
          candidatePath: asString(p.candidatePath ?? "/q/x.png", "candidatePath"),
        });
        const decision = (p.decision === "discard" ? "discard" : "accept") as "accept" | "discard";
        const decided = decideStudioStagingItem(area, asString(p.id ?? "demo", "id"), decision);
        return {
          kind: "studio-fusion-helper-result",
          schemaVersion: 1,
          operation: op,
          ok: decided.ok,
          result: {
            pendingBefore: 1,
            pendingAfter: decided.ok ? listPendingStudioStaging(decided.area).length : 1,
            decided,
          },
        };
      }
      case "publication-preflight": {
        const result = publicationPreflightLocal({
          width: asNumber(p.width, "width"),
          height: asNumber(p.height, "height"),
          durationSeconds: asNumber(p.durationSeconds, "durationSeconds"),
          lufs: typeof p.lufs === "number" ? p.lufs : undefined,
        });
        return { kind: "studio-fusion-helper-result", schemaVersion: 1, operation: op, ok: result.ok, result };
      }
      default:
        return {
          kind: "studio-fusion-helper-result",
          schemaVersion: 1,
          operation: op,
          ok: false,
          error: `未知 operation：${String(op)}`,
        };
    }
  } catch (e) {
    return {
      kind: "studio-fusion-helper-result",
      schemaVersion: 1,
      operation: req.operation,
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}
