export interface ElectronCloseEvidence {
  label: string;
  pid: number;
  durationMs: number;
  graceful: true;
  forceTerminated: false;
  forceKilled: false;
  exitCode: 0;
  signalCode: null;
}

export interface ElectronCloseOptions {
  label?: string;
  timeoutMs?: number;
  termTimeoutMs?: number;
  killTimeoutMs?: number;
}

export interface ElectronBackgroundWindowState {
  id: number;
  showEvents: number;
  focusEvents: number;
  readyToShowEvents: number;
  visible: boolean;
  focused: boolean;
  destroyed: boolean;
}

export interface ElectronBackgroundStateEvidence {
  label: string;
  enabled: true;
  platform: string;
  activationPolicy: "accessory" | "regular";
  dockVisible: boolean | null;
  focusedWindowId: number | null;
  windows: ElectronBackgroundWindowState[];
}

export function captureBackgroundElectronStateOrThrow(
  application: any,
  options?: { label?: string },
): Promise<ElectronBackgroundStateEvidence>;

export function closeElectronApplicationOrThrow(
  application: any,
  options?: ElectronCloseOptions,
): Promise<ElectronCloseEvidence>;

export function forceCleanupElectronApplication(
  application: any,
  options?: ElectronCloseOptions,
): Promise<{
  pid: number;
  forceTerminated: boolean;
  forceKilled: boolean;
  exited: boolean;
}>;
