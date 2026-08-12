export interface EvidenceOutputTarget {
  label: string;
  path: string;
}

export interface EvidenceRunLock {
  path: string;
  release(): Promise<void>;
}

export interface EvidenceLockFileHandle {
  writeFile(data: string, encoding: "utf8"): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

export interface EvidenceRunLockIo {
  openFile?: (path: string, flags: "wx", mode: number) => Promise<EvidenceLockFileHandle>;
  removeFile?: (path: string) => Promise<void>;
}

export function createUniqueEvidenceStem(prefix?: string): string;
export function assertFreshOutputSet(entries: EvidenceOutputTarget[]): Promise<void>;
export function createEvidenceRunLockOwner(
  lockPath: string,
  handle: Pick<EvidenceLockFileHandle, "close">,
  removeFile?: (path: string) => Promise<void>,
): EvidenceRunLock;
export function acquireEvidenceRunLock(
  evidencePath: string,
  runId: string,
  io?: EvidenceRunLockIo,
): Promise<EvidenceRunLock>;
export function writeBytesAtomicExclusive(targetPath: string, bytes: string | Uint8Array): Promise<void>;
export function writeJsonAtomicExclusive(targetPath: string, value: unknown): Promise<void>;
