export type IsolatedPackageTerminalOutcome = "passed" | "failed";

export interface IsolatedPackageCompletionMarker {
  schemaVersion: 1;
  kind: "isolated-package-smoke-completion";
  runId: string;
  terminalEvidencePath: string;
  terminalEvidenceSha256: string;
  lockPath: string;
  lockAbsent: true;
  status: IsolatedPackageTerminalOutcome;
  lockReleased: true;
  completedAt: string;
}

export interface IsolatedPackageTerminalFinalizationResult {
  terminal: Record<string, unknown> & {
    runId: string;
    lockPath: string;
    status: "finalization-pending";
    outcome: IsolatedPackageTerminalOutcome;
  };
  completion: IsolatedPackageCompletionMarker;
  completionMarkerPath: string;
}

export function isolatedPackageCompletionMarkerPath(evidencePath: string): string;
export function finalizeIsolatedPackageTerminalEvidence(input: {
  evidencePath: string;
  runId: string;
  outcome: IsolatedPackageTerminalOutcome;
  terminalEvidence: Record<string, unknown>;
  lockPath: string;
  releaseLock(): Promise<void>;
}): Promise<IsolatedPackageTerminalFinalizationResult>;
export function readCompletedIsolatedPackageTerminalEvidence(
  evidencePath: string,
): Promise<IsolatedPackageTerminalFinalizationResult>;
