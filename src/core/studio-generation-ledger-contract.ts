export type StudioGenerationResultVariant = "raw" | "labeled";

export type StudioGenerationLedgerErrorCode =
  | "unmanaged-project"
  | "pack-not-found"
  | "pack-schema-unsupported"
  | "pack-index-conflict"
  | "pack-cas-drift"
  | "pack-drift"
  | "dispatch-not-found"
  | "dispatch-conflict"
  | "result-media-missing"
  | "result-media-invalid"
  | "result-media-drift"
  | "result-conflict"
  | "result-not-found"
  | "result-promotion-ineligible"
  | "run-cancelled"
  | "run-terminal"
  | "call-intent-required"
  | "call-intent-conflict"
  | "call-intent-requires-bundle"
  | "generation-unknown"
  | "historical-import-conflict"
  | "target-extension-invalid"
  | "panel-run-in-flight"
  | "plan-node-run-id-mismatch"
  | "plan-node-run-owned-by-other-plan"
  | "plan-not-found"
  | "invalid-input"
  | "invalid-cursor"
  | "storage-invalid";

export class StudioGenerationLedgerError extends Error {
  readonly code: StudioGenerationLedgerErrorCode;
  readonly details: string[];

  constructor(code: StudioGenerationLedgerErrorCode, message: string, details: string[] = [], options?: ErrorOptions) {
    super(message, options);
    this.name = "StudioGenerationLedgerError";
    this.code = code;
    this.details = details;
  }
}

export class StudioGenerationResultConflictError extends StudioGenerationLedgerError {
  readonly generationRunId: string;
  readonly variant: StudioGenerationResultVariant;
  readonly existingResultId: string;

  constructor(
    generationRunId: string,
    variant: StudioGenerationResultVariant,
    existingResultId: string,
    details: string[],
  ) {
    super(
      "result-conflict",
      `generationRunId=${generationRunId} 的 ${variant} 结果已绑定其他内容，禁止静默换图。`,
      details,
    );
    this.name = "StudioGenerationResultConflictError";
    this.generationRunId = generationRunId;
    this.variant = variant;
    this.existingResultId = existingResultId;
  }
}

export interface StudioGenerationLedgerState {
  schemaVersion: 7;
  databasePath: string;
  packCasRoot: string;
  pragmas: {
    journalMode: "wal";
    foreignKeys: true;
    busyTimeoutMs: number;
  };
  counts: {
    packs: number;
    dispatches: number;
    results: number;
    pendingResults: number;
    staleAtRegistrationResults: number;
    plans: number;
    runEvents: number;
    targetExtensions: number;
    callIntents: number;
    callEvents: number;
    historicalImports: number;
    detachedUnknownObservations: number;
    detachedUnknownDispositions: number;
  };
}
