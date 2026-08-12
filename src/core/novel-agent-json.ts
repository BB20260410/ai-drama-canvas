import { z } from "zod";
import { executeIdempotentCommand } from "./command-bus.js";
import {
  isConfirmedCommandFailure,
  isRejectedCommandFailure,
} from "./command-outcome.js";
import {
  buildNovelContextPack,
  compareNovelWritingSourceReceipts,
  doctorNovelAgent,
  getNovelAgentCapabilities,
  getNovelManuscriptWorkspace,
  getNovelStateRebuildStatus,
  getNovelWritingState,
  listNovelManuscriptChapters,
  listNovelWritingSourceReceipts,
  planNovelStateRebuild,
  probeNovelChapterConsistency,
  readNovelManuscriptRange,
  preflightNovelChapterWrite,
  prepareNovelChapterWrite,
  resolveNovelAgentProject,
  searchNovelManuscript,
} from "./novel-agent-service.js";
import {
  isNovelImportCommandRequest,
  parseNovelCommandRequestForCore,
} from "./novel-command-runtime.js";
import { isNovelWritingStateRejectedError } from "./novel-writing-state.js";

export const NOVEL_AGENT_JSON_SCHEMA_VERSION = 1 as const;

const projectRootSchema = z.string().trim().min(1).optional();
const baseShape = {
  schemaVersion: z.literal(NOVEL_AGENT_JSON_SCHEMA_VERSION),
  projectRoot: projectRootSchema,
};
const novelActorAttributionSchema = z.object({
  actorId: z.string().trim().min(1).max(500),
  provider: z.string().trim().min(1).max(500),
  model: z.string().trim().min(1).max(500),
  sessionId: z.string().trim().min(1).max(500),
  transport: z.enum(["mcp", "json_cli", "main", "internal"]),
}).strict();
const prepareChapterWriteInputSchema = z.object({
  taskType: z.enum(["continue_chapter", "revise_chapter"]).default("continue_chapter"),
  targetChapterId: z.string().min(1),
  query: z.string().trim().min(2).max(200).optional(),
  chapterIds: z.array(z.string().min(1)).max(50).optional(),
  characterIds: z.array(z.string().min(1).max(240)).max(1_000).optional(),
  maxCharacters: z.number().int().min(256).max(200_000).default(12_000),
  maxSearchHits: z.number().int().min(1).max(50).default(20),
  workflowMode: z.enum(["formal", "rehearsal"]).default("formal"),
  attribution: novelActorAttributionSchema,
  ttlSeconds: z.number().int().min(60).max(1_800).default(900),
}).strict();

export const novelAgentJsonRequestSchema = z.discriminatedUnion("operation", [
  z.object({
    schemaVersion: z.literal(NOVEL_AGENT_JSON_SCHEMA_VERSION),
    operation: z.literal("capabilities"),
  }).strict(),
  z.object({
    ...baseShape,
    operation: z.literal("doctor"),
    input: z.object({
      targetChapterId: z.string().min(1).optional(),
      workflowMode: z.enum(["formal", "rehearsal"]).default("formal"),
    }).strict().default({ workflowMode: "formal" }),
  }).strict(),
  z.object({
    ...baseShape,
    operation: z.literal("workspace"),
  }).strict(),
  z.object({
    ...baseShape,
    operation: z.literal("list_chapters"),
    input: z.object({
      targetChapterId: z.string().min(1),
      cutoff: z.enum(["before", "through"]),
      offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(500).default(100),
    }).strict(),
  }).strict(),
  z.object({
    ...baseShape,
    operation: z.literal("read_chapter_range"),
    input: z.object({
      targetChapterId: z.string().min(1),
      cutoff: z.enum(["before", "through"]),
      chapterId: z.string().min(1),
      startOffset: z.number().int().min(0).default(0),
      maxCharacters: z.number().int().min(1).max(200_000).default(12_000),
    }).strict(),
  }).strict(),
  z.object({
    ...baseShape,
    operation: z.literal("search"),
    input: z.object({
      targetChapterId: z.string().min(1),
      cutoff: z.enum(["before", "through"]),
      query: z.string().trim().min(2).max(200),
      limit: z.number().int().min(1).max(200).default(50),
      maxHitsPerChapter: z.number().int().min(1).max(20).default(5),
    }).strict(),
  }).strict(),
  z.object({
    ...baseShape,
    operation: z.literal("get_writing_state"),
    input: z.object({
      targetChapterId: z.string().min(1),
      cutoff: z.enum(["before", "through"]),
      characterIds: z.array(z.string().min(1).max(240)).max(1_000).optional(),
    }).strict(),
  }).strict(),
  z.object({
    ...baseShape,
    operation: z.literal("list_writing_source_receipts"),
  }).strict(),
  z.object({
    ...baseShape,
    operation: z.literal("compare_writing_source_receipts"),
    input: z.object({
      baseReceiptId: z.string().regex(/^novel-writing-source-receipt-[a-f0-9]{32}$/u),
      currentReceiptId: z.string().regex(/^novel-writing-source-receipt-[a-f0-9]{32}$/u),
    }).strict(),
  }).strict(),
  z.object({
    ...baseShape,
    operation: z.literal("plan_state_rebuild"),
    input: z.object({ targetChapterId: z.string().min(1) }).strict(),
  }).strict(),
  z.object({
    ...baseShape,
    operation: z.literal("get_state_rebuild_status"),
  }).strict(),
  z.object({
    ...baseShape,
    operation: z.literal("probe_chapter_consistency"),
    input: z.object({
      targetChapterId: z.string().min(1),
      workflowMode: z.enum(["formal", "rehearsal"]).default("formal"),
    }).strict(),
  }).strict(),
  z.object({
    ...baseShape,
    operation: z.literal("build_context_pack"),
    input: z.object({
      query: z.string().trim().min(2).max(200).optional(),
      chapterIds: z.array(z.string().min(1)).max(50).optional(),
      cutoffChapterId: z.string().min(1).optional(),
      maxCharacters: z.number().int().min(256).max(200_000).default(12_000),
      maxSearchHits: z.number().int().min(1).max(50).default(20),
      workflowMode: z.enum(["formal", "rehearsal"]).default("formal"),
      taskType: z.enum(["continue_chapter", "revise_chapter", "review_chapter"]).optional(),
      targetChapterId: z.string().min(1).optional(),
      characterIds: z.array(z.string().min(1).max(240)).max(1_000).optional(),
    }).strict(),
  }).strict(),
  z.object({
    ...baseShape,
    operation: z.literal("preflight_chapter_write"),
    input: z.object({
      taskType: z.enum(["continue_chapter", "revise_chapter"]).default("continue_chapter"),
      targetChapterId: z.string().min(1),
      contextPackFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
      query: z.string().trim().min(2).max(200).optional(),
      chapterIds: z.array(z.string().min(1)).max(50).optional(),
      characterIds: z.array(z.string().min(1).max(240)).max(1_000).optional(),
      maxCharacters: z.number().int().min(256).max(200_000).default(12_000),
      maxSearchHits: z.number().int().min(1).max(50).default(20),
      workflowMode: z.enum(["formal", "rehearsal"]).default("formal"),
    }).strict(),
  }).strict(),
  z.object({
    ...baseShape,
    operation: z.literal("prepare_chapter_write"),
    input: prepareChapterWriteInputSchema,
  }).strict(),
  z.object({
    ...baseShape,
    operation: z.literal("prepare_novel_chapter_write"),
    input: prepareChapterWriteInputSchema,
  }).strict(),
  z.object({
    ...baseShape,
    operation: z.literal("execute_command"),
    input: z.object({
      requestId: z.string().min(8).max(160),
      idempotencyKey: z.string().min(8).max(200),
      request: z.unknown(),
      novelWriteLeaseToken: z.string().regex(/^novel-lease-token-[A-Za-z0-9_-]{43}$/u).optional(),
      novelActorAttribution: novelActorAttributionSchema.optional(),
    }).strict(),
  }).strict(),
]);

export type NovelAgentJsonRequest = z.infer<typeof novelAgentJsonRequestSchema>;

export class NovelAgentJsonContractError extends Error {
  readonly code: "INVALID_REQUEST" | "UNSUPPORTED_COMMAND";
  readonly details?: unknown;

  constructor(
    code: NovelAgentJsonContractError["code"],
    message: string,
    details?: unknown,
  ) {
    super(message);
    this.name = "NovelAgentJsonContractError";
    this.code = code;
    this.details = details;
  }
}

function zodIssueSummary(error: z.ZodError): string {
  return error.issues.slice(0, 8)
    .map((issue) => `${issue.path.join(".") || "request"}: ${issue.message}`)
    .join("；");
}

export function parseNovelAgentJsonRequest(value: unknown): NovelAgentJsonRequest {
  const parsed = novelAgentJsonRequestSchema.safeParse(value);
  if (!parsed.success) {
    throw new NovelAgentJsonContractError(
      "INVALID_REQUEST",
      `Novel Agent JSON 请求不符合合同：${zodIssueSummary(parsed.error)}`,
      parsed.error.issues,
    );
  }
  return parsed.data;
}

export async function executeNovelAgentJsonRequest(value: unknown): Promise<{
  operation: NovelAgentJsonRequest["operation"];
  data: unknown;
}> {
  const request = parseNovelAgentJsonRequest(value);
  switch (request.operation) {
    case "capabilities":
      return { operation: request.operation, data: getNovelAgentCapabilities() };
    case "doctor":
      return { operation: request.operation, data: await doctorNovelAgent(request.projectRoot, request.input) };
    case "workspace":
      return { operation: request.operation, data: await getNovelManuscriptWorkspace(request.projectRoot) };
    case "list_chapters":
      return {
        operation: request.operation,
        data: await listNovelManuscriptChapters(request.projectRoot, {
          offset: request.input.offset,
          limit: request.input.limit,
          taskScope: { targetChapterId: request.input.targetChapterId, cutoff: request.input.cutoff },
        }),
      };
    case "read_chapter_range":
      return {
        operation: request.operation,
        data: await readNovelManuscriptRange(request.projectRoot, {
          chapterId: request.input.chapterId,
          startOffset: request.input.startOffset,
          maxCharacters: request.input.maxCharacters,
          taskScope: { targetChapterId: request.input.targetChapterId, cutoff: request.input.cutoff },
        }),
      };
    case "search":
      return {
        operation: request.operation,
        data: await searchNovelManuscript(request.projectRoot, {
          query: request.input.query,
          limit: request.input.limit,
          maxHitsPerChapter: request.input.maxHitsPerChapter,
          taskScope: { targetChapterId: request.input.targetChapterId, cutoff: request.input.cutoff },
        }),
      };
    case "get_writing_state":
      return {
        operation: request.operation,
        data: await getNovelWritingState(request.projectRoot, request.input),
      };
    case "list_writing_source_receipts":
      return {
        operation: request.operation,
        data: await listNovelWritingSourceReceipts(request.projectRoot),
      };
    case "compare_writing_source_receipts":
      return {
        operation: request.operation,
        data: await compareNovelWritingSourceReceipts(request.projectRoot, request.input),
      };
    case "plan_state_rebuild":
      return {
        operation: request.operation,
        data: await planNovelStateRebuild(request.projectRoot, request.input),
      };
    case "get_state_rebuild_status":
      return {
        operation: request.operation,
        data: await getNovelStateRebuildStatus(request.projectRoot),
      };
    case "probe_chapter_consistency":
      return {
        operation: request.operation,
        data: await probeNovelChapterConsistency(request.projectRoot, request.input),
      };
    case "build_context_pack":
      return {
        operation: request.operation,
        data: await buildNovelContextPack(request.projectRoot, request.input),
      };
    case "preflight_chapter_write":
      return {
        operation: request.operation,
        data: await preflightNovelChapterWrite(request.projectRoot, request.input),
      };
    case "prepare_chapter_write":
    case "prepare_novel_chapter_write":
      return {
        operation: request.operation,
        data: await prepareNovelChapterWrite(request.projectRoot, request.input),
      };
    case "execute_command": {
      let command;
      try {
        command = parseNovelCommandRequestForCore(request.input.request);
      } catch (error) {
        throw new NovelAgentJsonContractError(
          "INVALID_REQUEST",
          error instanceof Error ? error.message : String(error),
        );
      }
      if (!command || isNovelImportCommandRequest(command)) {
        throw new NovelAgentJsonContractError(
          "UNSUPPORTED_COMMAND",
          "JSON CLI 只允许受管小说命令；外部导入继续由桌面预检能力控制。",
        );
      }
      const project = await resolveNovelAgentProject(request.projectRoot);
      return {
        operation: request.operation,
        data: await executeIdempotentCommand(project.projectRoot, {
          requestId: request.input.requestId,
          idempotencyKey: request.input.idempotencyKey,
          request: command,
        }, {
          ...(request.input.novelWriteLeaseToken ? { novelWriteLeaseToken: request.input.novelWriteLeaseToken } : {}),
          ...(request.input.novelActorAttribution ? { novelActorAttribution: request.input.novelActorAttribution } : {}),
        }),
      };
    }
  }
}

export function projectNovelAgentJsonError(error: unknown): {
  code: string;
  message: string;
  details?: unknown;
} {
  if (error instanceof NovelAgentJsonContractError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.details !== undefined ? { details: error.details } : {}),
    };
  }
  if (isRejectedCommandFailure(error)) {
    return { code: "COMMAND_REJECTED", message: error.message, details: error.result };
  }
  if (isNovelWritingStateRejectedError(error)) {
    return { code: "OPERATION_REJECTED", message: error.message, details: error.result };
  }
  if (isConfirmedCommandFailure(error)) {
    return { code: "COMMAND_FAILED", message: error.message, details: error.result };
  }
  return {
    code: "OPERATION_FAILED",
    message: error instanceof Error ? error.message : String(error),
  };
}
