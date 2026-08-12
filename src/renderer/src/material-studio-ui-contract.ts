import type {
  CrossProjectAssetExportManifest,
  ExportStudioCrossProjectAssetPackageResult,
  ImportStudioCrossProjectAssetPackageResult,
} from "../../core/studio-cross-project-asset-reuse.js";
import type {
  GlobalStudioImageResourcePage,
  GlobalStudioImageResourceQuery,
} from "../../core/studio-global-image-resource-catalog.js";
import type {
  GlobalStudioMediaResourcePage,
  GlobalStudioMediaResourceQuery,
} from "../../core/studio-global-asset-catalog.js";
import type { ReuseStudioGlobalResourceInput, ReuseStudioGlobalResourceResult } from "../../core/studio-global-resource-reuse.js";
import type { ScriptLibraryIndex } from "../../core/studio-script-library-projection.js";
import type { ScriptReaderView } from "../../core/studio-script-library-reader.js";
import type { StudioProductionUnitListQuery, StudioProductionUnitPage } from "../../core/studio-production.js";
import type { StudioStoryboardWizardSession, WizardEditablePanel } from "../../core/studio-storyboard-wizard.js";

export type MaterialStudioSection = "script" | "prompt" | "character" | "scene" | "prop" | "style" | "media";
export type MaterialStudioAssetCategory = "character" | "scene" | "prop" | "style";
export type MaterialStudioAssetScope = "current" | "all";
export type MaterialStudioAssetRepresentation = "images" | "assets";
export type MaterialStudioReviewStatus = "pending" | "approved" | "rejected";
export type MaterialStudioAuthorityState = "locked" | "candidate" | "missing";
export type MaterialStudioAssetRelationKind = "derived_from" | "variant_of" | "reference_of" | "composite_member";

export interface MaterialStudioApplicability {
  projects: string[];
  seasons: string[];
  episodes: string[];
  units: string[];
  timeRanges: Array<{
    scope: "episode" | "unit";
    scopeId: string;
    startSeconds: number;
    endSeconds: number;
    label?: string;
  }>;
  tags: string[];
}

export interface MaterialStudioUiRelation {
  id: string;
  seriesId: string;
  revision: number;
  supersedesRelationId?: string;
  supersededByRelationId?: string;
  head: boolean;
  status: "current" | "stale" | "superseded";
  kind: MaterialStudioAssetRelationKind;
  subjectAssetId: string;
  objectAssetId: string;
  subjectRevision: number;
  objectRevision: number;
  ordinal?: number;
  role: string;
  note: string;
  fingerprint: string;
}

export interface MaterialStudioUiCounts {
  total: number;
  textDocuments: number;
  scripts: number;
  prompts: number;
  character: number;
  scene: number;
  prop: number;
  style: number;
  media: number;
  canonicalAssets: number;
}

export interface MaterialStudioTimelineSegment {
  id: string;
  label: string;
  durationSeconds: number;
  status: "pending" | "current" | "complete";
}

export interface MaterialStudioProjectOverview {
  projectName: string;
  nextAction: string;
  nextActionControl?: {
    code: string;
    label: string;
    reason: string;
    requiresWrite: boolean;
    locator?: { kind: string; unitId?: string; panelId?: string; assetId?: string; queue?: string; itemId?: string };
  };
  counts: MaterialStudioUiCounts;
  timeline: {
    currentLabel?: string;
    unitCount: number;
    completedUnitCount: number;
    segments: MaterialStudioTimelineSegment[];
  };
}

export interface MaterialStudioUiEntry {
  id: string;
  kind: MaterialStudioSection | "image" | "video" | "audio";
  title: string;
  subtitle?: string;
  summary?: string;
  meta?: string;
  episode?: number;
  thumbnailUrl?: string;
  mediaSha256?: string;
  authorityState?: MaterialStudioAuthorityState;
  updatedAt?: string;
  sourceProjectId?: string;
  sourceProjectName?: string;
  sourceProjectRoot?: string;
  sourceEntryId?: string;
  resourceImage?: {
    mediaSha256: string;
    associations: Array<{
      assetId: string;
      name: string;
      category: MaterialStudioAssetCategory;
      versionId: string;
      versionOrdinal: number;
      reviewStatus: MaterialStudioReviewStatus;
      isPrimary: boolean;
    }>;
  };
}

export interface MaterialStudioUiAssetCounts {
  total: number;
  character: number;
  scene: number;
  prop: number;
  style: number;
}

export interface MaterialStudioUiImageCoverage {
  totalImages: number;
  assetVersionImages: number;
  ordinaryImages: number;
}

export interface MaterialStudioUiUnavailableProject {
  id: string;
  name: string;
  reason: "not-managed" | "material-database-invalid";
}

export interface MaterialStudioUiPage {
  items: MaterialStudioUiEntry[];
  nextCursor?: string;
  total?: number;
  counts?: MaterialStudioUiAssetCounts;
  resourceCounts?: MaterialStudioUiAssetCounts;
  imageCoverage?: MaterialStudioUiImageCoverage;
  registeredProjectCount?: number;
  readableProjectCount?: number;
  unavailableProjects?: MaterialStudioUiUnavailableProject[];
}

export interface MaterialStudioUiVersion {
  id: string;
  ordinal: number;
  ownerAssetId?: string;
  ownerName?: string;
  ownerCategory?: MaterialStudioAssetCategory;
  mediaSha256: string;
  thumbnailUrl?: string;
  mediaUrl?: string;
  reviewStatus: MaterialStudioReviewStatus;
  isPrimary: boolean;
  sourceNote?: string;
  reviewNote?: string;
  createdAt?: string;
}

export interface MaterialStudioUiDetail {
  id: string;
  kind: MaterialStudioSection | "image" | "video" | "audio";
  title: string;
  description?: string;
  revision: number;
  aliases?: string[];
  authorityThumbnailUrl?: string;
  primaryAuthority?: { versionId: string; mediaSha256: string };
  mediaPreview?: {
    status: "ready" | "blocked" | "failed" | "not-required";
    message: string;
    previewUrl?: string;
    playbackUrl?: string;
    mimeType: string;
  };
  versions?: MaterialStudioUiVersion[];
  resourceImage?: {
    mediaSha256: string;
    sourceBasename: string;
    mimeType: string;
    sizeBytes: number;
    associations: Array<{
      assetId: string;
      name: string;
      category: MaterialStudioAssetCategory;
      versionId: string;
      versionOrdinal: number;
      reviewStatus: MaterialStudioReviewStatus;
      isPrimary: boolean;
      sourceNote?: string;
    }>;
  };
  identityFeatures?: string[];
  positiveLocks?: string[];
  negativeLocks?: string[];
  applicability?: MaterialStudioApplicability;
  relations?: MaterialStudioUiRelation[];
  prompt?: { positive?: string; negative?: string; frozenPackId?: string };
  textDocument?: {
    kind: "script" | "prompt";
    bodyPreview: string;
    bodySizeBytes: number;
    bodySha256: string;
    source: string;
    sourceVersion: string;
    truncated: boolean;
  };
}

export interface MaterialStudioUiListQuery {
  section: MaterialStudioSection;
  scope: MaterialStudioAssetScope;
  representation: MaterialStudioAssetRepresentation;
  search?: string;
  cursor?: string;
  limit: number;
}

export interface MaterialStudioCreateAssetInput {
  category: MaterialStudioAssetCategory;
  name: string;
  description?: string;
  aliases?: string[];
  identityFeatures?: string[];
  positiveLocks?: string[];
  negativeLocks?: string[];
  defaultPrompt?: string;
  applicability?: Partial<MaterialStudioApplicability>;
  expectedRevision: 0;
}

export interface MaterialStudioAppendRelationInput {
  assetId: string;
  relatedAssetId: string;
  kind: MaterialStudioAssetRelationKind;
  ordinal?: number;
  role?: string;
  note?: string;
  expectedRevision: number;
}

export interface MaterialStudioRebaseRelationInput {
  assetId: string;
  relation: MaterialStudioUiRelation;
}

export interface MaterialStudioImportResult {
  imported: boolean;
  entryId?: string;
}

export interface MaterialStudioAppendPendingVersionInput {
  assetId: string;
  mediaSha256: string;
  expectedRevision: number;
  sourceNote: string;
}

export interface MaterialStudioReviewPendingVersionInput {
  assetId: string;
  versionId: string;
  decision: "approved" | "rejected";
  expectedRevision: number;
  note: string;
}

export interface MaterialStudioUiApi {
  openProjectCenter?(): void;
  listGlobalResourceImages?(query: GlobalStudioImageResourceQuery): Promise<GlobalStudioImageResourcePage>;
  listGlobalMediaResources?(query: GlobalStudioMediaResourceQuery): Promise<GlobalStudioMediaResourcePage>;
  reuseGlobalResource?(targetProjectRoot: string, input: ReuseStudioGlobalResourceInput): Promise<ReuseStudioGlobalResourceResult>;
  getOverview(projectRoot: string): Promise<MaterialStudioProjectOverview>;
  listEntries(projectRoot: string, query: MaterialStudioUiListQuery): Promise<MaterialStudioUiPage>;
  getEntryDetail(projectRoot: string, entryId: string): Promise<MaterialStudioUiDetail | null>;
  listTextRevisions?(projectRoot: string, query: { documentId: string; limit?: number }): Promise<{ items: Array<{ id: string; ordinal: number; bodySha256: string }>; nextCursor?: string }>;
  chooseAndImportScript(projectRoot: string): Promise<MaterialStudioImportResult>;
  chooseAndImportPrompt(projectRoot: string): Promise<MaterialStudioImportResult>;
  chooseAndImportMedia(projectRoot: string): Promise<MaterialStudioImportResult>;
  createAsset(projectRoot: string, input: MaterialStudioCreateAssetInput): Promise<{ assetId: string }>;
  appendPendingAssetVersion?(projectRoot: string, input: MaterialStudioAppendPendingVersionInput): Promise<MaterialStudioUiDetail>;
  reviewPendingAssetVersion?(projectRoot: string, input: MaterialStudioReviewPendingVersionInput): Promise<MaterialStudioUiDetail>;
  promoteApprovedAuthority(projectRoot: string, input: { assetId: string; versionId: string; expectedRevision: number }): Promise<MaterialStudioUiDetail>;
  appendAssetRelation?(projectRoot: string, input: MaterialStudioAppendRelationInput): Promise<MaterialStudioUiDetail>;
  rebaseAssetRelation?(projectRoot: string, input: MaterialStudioRebaseRelationInput): Promise<MaterialStudioUiDetail>;
  exportCrossProjectAssetPackage?(projectRoot: string, input: { assetId: string; expectedRevision: number }): Promise<ExportStudioCrossProjectAssetPackageResult | null>;
  pickCrossProjectAssetPackage?(): Promise<{ packageRoot: string; manifest: CrossProjectAssetExportManifest } | null>;
  importCrossProjectAssetPackage?(projectRoot: string, input: {
    packageRoot: string;
    expectedPackageFingerprint: string;
    expectedSourceProjectId: string;
    sourceAssetId: string;
    sourceVersionId: string;
    targetExpectedRevision: 0;
  }): Promise<ImportStudioCrossProjectAssetPackageResult>;
  openTimeline(projectRoot: string): Promise<void>;
}

export interface StudioScriptProductUiApi {
  listUnits(projectRoot: string, query: StudioProductionUnitListQuery): Promise<StudioProductionUnitPage>;
  getLibraryIndex(projectRoot: string, query: { limit?: number; kind?: "script" | "prompt" }): Promise<ScriptLibraryIndex>;
  getReaderView(projectRoot: string, query: {
    documentId?: string;
    revisionId?: string;
    season?: string;
    episode?: string;
    includeBody?: boolean;
    evidenceDir?: string;
  }): Promise<ScriptReaderView>;
  getStudioScriptMediaAlignBoard(projectRoot: string, query: { season: string; episode: string }): Promise<import("../../core/studio-script-media-align.js").ScriptMediaAlignBoard>;
  openStoryboardWizard(projectRoot: string, input: {
    scriptRevisionId: string;
    panelCount?: number;
    sourceRange?: { startOffsetUtf16: number; endOffsetUtf16: number };
  }): Promise<StudioStoryboardWizardSession>;
  getMediaPreview(projectRoot: string, sha256: string): Promise<{ mediaUrl: string; thumbnailUrl?: string; kind: string } | null>;
  importScript(projectRoot: string): Promise<{ imported: boolean; entryId?: string; unchanged?: boolean; revision?: unknown }>;
  materializeStoryboardWizard(projectRoot: string, input: {
    season: string;
    episode: string;
    sequence: number;
    unitTitle: string;
    scriptRevisionId: string;
    panels: WizardEditablePanel[];
  }): Promise<{
    unitId: string;
    unitRevision: number;
    promptDocumentId: string;
    promptRevisionId: string;
    panelStatuses: Array<{ panelId: string; panelIndex: number; status: string }>;
  }>;
}
