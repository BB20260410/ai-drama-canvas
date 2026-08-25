import { NOVEL_OFFSET_ENCODING } from "./novel-types.js";

export const NOVEL_AGENT_CONTRACT_VERSION = 1 as const;
export const NOVEL_AGENT_DEFAULT_READ_CHARACTERS = 12_000;
export const NOVEL_AGENT_MAX_READ_CHARACTERS = 200_000;
export const NOVEL_AGENT_DEFAULT_CONTEXT_CHARACTERS = 12_000;
export const NOVEL_AGENT_MAX_CONTEXT_CHARACTERS = 200_000;
export const NOVEL_AGENT_MAX_CONTEXT_CHAPTERS = 50;
export const NOVEL_AGENT_DEFAULT_CONTEXT_CHAPTERS = 3;
export const NOVEL_AGENT_MAX_CONTEXT_SEARCH_HITS = 50;

export const NOVEL_AGENT_CAPABILITIES = {
  schemaVersion: NOVEL_AGENT_CONTRACT_VERSION,
  kind: "novel-agent-capabilities",
  contract: "aicanvas.novel-agent",
  transport: {
    mcp: true,
    jsonCli: true,
    projectSelection: "explicit-project-root-or-active-registration",
  },
  authority: {
    manuscript: "managed-markdown-and-json-manifests",
    derivedDatabaseRequired: false,
    writes: "execute-command-only",
    agentChapterBodyWrites: "empty-create-then-context-pack-preflight-save",
    humanDesktopCompatibility: "explicit-human-ui-actor",
  },
  offsets: {
    encoding: NOVEL_OFFSET_ENCODING,
    interval: "half-open",
  },
  operations: {
    read: [
      "doctor",
      "workspace",
      "list_chapters",
      "read_chapter_range",
      "search",
      "get_search_index_status",
      "get_writing_state",
      "build_context_pack",
      "preflight_chapter_write",
      "plan_novel_state_rebuild",
      "get_state_rebuild_status",
      "probe_chapter_consistency",
      "list_writing_source_receipts",
      "compare_writing_source_receipts",
    ],
    writeCommands: [
      "novel_initialize_manuscript",
      "novel_create_volume",
      "novel_create_chapter",
      "novel_save_chapter",
      "novel_rename_chapter",
      "novel_move_chapter",
      "novel_reorder_chapters",
      "novel_rebuild_search_index",
      "novel_recover_manuscript",
      "novel_recover_writing_state",
      "novel_seed_writing_state",
      "novel_stage_chapter_state_candidate",
      "novel_review_chapter_state_candidate",
      "novel_stage_story_bible_candidate",
      "novel_review_story_bible_candidate",
      "novel_invalidate_writing_state_from",
      "novel_attach_review_ticket",
      "novel_import_writing_source_snapshot",
    ],
    controlTools: ["prepare_novel_chapter_write"],
    controlOperations: [{
      operationId: "prepare_chapter_write",
      recommended: true,
      transports: {
        mcpTool: "prepare_novel_chapter_write",
        jsonCliOperation: "prepare_novel_chapter_write",
        jsonCliLegacyAliases: ["prepare_chapter_write"],
      },
    }],
  },
  limits: {
    chapterPageMax: 500,
    readCharactersDefault: NOVEL_AGENT_DEFAULT_READ_CHARACTERS,
    readCharactersMax: NOVEL_AGENT_MAX_READ_CHARACTERS,
    searchQueryCharacters: { minimum: 2, maximum: 200 },
    searchHitsMax: 200,
    contextCharactersDefault: NOVEL_AGENT_DEFAULT_CONTEXT_CHARACTERS,
    contextCharactersMax: NOVEL_AGENT_MAX_CONTEXT_CHARACTERS,
    contextChapterIdsMax: NOVEL_AGENT_MAX_CONTEXT_CHAPTERS,
  },
  consistency: {
    readIdentity: ["chapterId", "revision", "sha256", "offsetEncoding"],
    saveCas: ["expectedRevision", "expectedSha256"],
    contextFutureBoundary: "cutoffChapterId-inclusive",
    externalChanges: "reported-and-skipped",
    stateHistory: "append-only-event-checkpoint-with-shadow-rebuild-promotion",
    stateRecovery: "intent-before-after-cas-fail-on-third-sha",
  },
} as const;
