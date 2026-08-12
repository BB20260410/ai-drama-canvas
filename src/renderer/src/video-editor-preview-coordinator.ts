import { LatestBoundedTaskQueue } from "./bounded-task-queue.js";

export interface VideoEditorNestedPreviewClipLike {
  id: string;
  kind: string;
  startSeconds: number;
  durationSeconds: number;
}

export interface VideoEditorNestedPreviewTrackLike {
  clips: readonly VideoEditorNestedPreviewClipLike[];
}

export interface VideoEditorNestedPreviewDemand {
  priorityClips: readonly (VideoEditorNestedPreviewClipLike | null | undefined)[];
  tracks: readonly VideoEditorNestedPreviewTrackLike[];
  gestureClipId: string;
  visibleStart: number;
  visibleEnd: number;
}

/**
 * Selects only nested clips that are immediately useful to the editor.  The
 * returned order is stable: direct interaction/playback roles first, followed
 * by timeline order for the visible window.
 */
export function collectVideoEditorNestedPreviewIds(input: VideoEditorNestedPreviewDemand): string[] {
  const wanted: string[] = [];
  const seen = new Set<string>();
  const add = (clip: VideoEditorNestedPreviewClipLike | null | undefined) => {
    if (clip?.kind !== "timeline" || seen.has(clip.id)) return;
    seen.add(clip.id);
    wanted.push(clip.id);
  };
  for (const clip of input.priorityClips) add(clip);
  for (const track of input.tracks) {
    for (const clip of track.clips) {
      if (clip.id === input.gestureClipId
        || (clip.startSeconds < input.visibleEnd && clip.startSeconds + clip.durationSeconds > input.visibleStart)) {
        add(clip);
      }
    }
  }
  return wanted;
}

export interface KeyedPreviewCoordinatorOptions<Key, Value, Scope> {
  execute: (key: Key, scope: Scope) => Promise<Value>;
  onSuccess: (key: Key, value: Value, scope: Scope) => void;
  onError: (key: Key, error: unknown, scope: Scope) => void;
  onStart?: (key: Key, scope: Scope) => void;
  onSettled?: (key: Key, scope: Scope) => void;
  isEligible?: (key: Key, scope: Scope) => boolean;
}

/**
 * Shares one preview pause across concurrent foreground operations.  The first
 * holder performs cancellation/drain; previews resume only after the last
 * holder releases its lease.
 */
export class ReferenceCountedPreviewSuspension {
  private depth = 0;
  private settled: Promise<void> | null = null;

  constructor(
    private readonly suspendOnce: () => Promise<void>,
    private readonly resumeOnce: () => void,
  ) {}

  async acquire(): Promise<void> {
    this.depth += 1;
    if (this.depth > 1) return this.settled ?? Promise.resolve();
    this.settled = Promise.resolve().then(this.suspendOnce);
    try {
      await this.settled;
    } catch (error) {
      this.depth = 0;
      this.settled = null;
      throw error;
    }
  }

  release(): void {
    if (this.depth === 0) return;
    this.depth -= 1;
    if (this.depth !== 0) return;
    this.settled = null;
    this.resumeOnce();
  }
}

type RunValue<Value> = { kind: "value"; value: Value } | { kind: "skipped" };

type Flight<Key, Scope> = {
  key: Key;
  scope: Scope;
  generation: number;
};

/**
 * A renderer-local latest-wins coordinator for preview-only background work.
 * It keeps its own ordered wanted set, so only concurrency slots are submitted
 * to the underlying bounded queue; callers never receive a promise to await.
 */
export class KeyedPreviewCoordinator<Key, Value, Scope> {
  private readonly queue: LatestBoundedTaskQueue;
  private readonly ownsQueue: boolean;
  private readonly wanted = new Map<Key, true>();
  private readonly flights = new Map<Key, Flight<Key, Scope>>();
  private readonly settled = new Set<Key>();
  private scope: Scope | undefined;
  private generation = 0;
  private active = 0;
  private disposed = false;
  private pumpQueued = false;

  constructor(
    private readonly options: KeyedPreviewCoordinatorOptions<Key, Value, Scope>,
    private readonly concurrency = 2,
    executionQueue?: LatestBoundedTaskQueue,
  ) {
    this.queue = executionQueue ?? new LatestBoundedTaskQueue(concurrency);
    this.ownsQueue = executionQueue === undefined;
  }

  activate(scope: Scope): void {
    if (this.disposed) return;
    this.generation += 1;
    this.scope = scope;
    this.wanted.clear();
    this.flights.clear();
    this.settled.clear();
    this.active = 0;
    if (this.ownsQueue) this.queue.invalidate();
  }

  /** Replaces the ordered demand set; omitted queued keys will never invoke execute. */
  reconcile(keys: Iterable<Key>): void {
    if (this.disposed || this.scope === undefined) return;
    this.wanted.clear();
    for (const key of keys) this.wanted.set(key, true);
    this.requestPump();
  }

  /** Adds one key without replacing existing demand (used by media hover). */
  enqueue(key: Key): void {
    if (this.disposed || this.scope === undefined) return;
    this.wanted.set(key, true);
    this.requestPump();
  }

  invalidate(): void {
    if (this.disposed) return;
    this.generation += 1;
    this.scope = undefined;
    this.wanted.clear();
    this.flights.clear();
    this.settled.clear();
    this.active = 0;
    if (this.ownsQueue) this.queue.invalidate();
  }

  dispose(): void {
    if (this.disposed) return;
    this.invalidate();
    this.disposed = true;
    if (this.ownsQueue) this.queue.dispose();
  }

  private requestPump(): void {
    if (this.pumpQueued) return;
    this.pumpQueued = true;
    queueMicrotask(() => {
      this.pumpQueued = false;
      this.pump();
    });
  }

  private pump(): void {
    while (!this.disposed && this.scope !== undefined && this.active < this.concurrency) {
      const key = [...this.wanted.keys()].find((candidate) => !this.flights.has(candidate) && !this.settled.has(candidate));
      if (key === undefined) return;
      const flight: Flight<Key, Scope> = { key, scope: this.scope, generation: this.generation };
      this.flights.set(key, flight);
      this.active += 1;
      this.queue.schedule<RunValue<Value>>(() => Promise.resolve().then(async () => {
        if (!this.canRun(flight)) return { kind: "skipped" };
        this.options.onStart?.(flight.key, flight.scope);
        if (!this.canRun(flight)) return { kind: "skipped" };
        return { kind: "value", value: await this.options.execute(flight.key, flight.scope) };
      })).then((result) => {
        if (!this.canAccept(flight)) return;
        if (result.status === "fulfilled" && result.value.kind === "value") {
          this.options.onSuccess(flight.key, result.value.value, flight.scope);
        } else if (result.status === "rejected") {
          this.options.onError(flight.key, result.reason, flight.scope);
        }
      }).finally(() => {
        if (!this.isCurrent(flight)) return;
        if (this.flights.get(flight.key) === flight) {
          this.flights.delete(flight.key);
          this.active -= 1;
          if (this.wanted.has(flight.key)) this.settled.add(flight.key);
          if (this.canAccept(flight)) this.options.onSettled?.(flight.key, flight.scope);
          this.requestPump();
        }
      });
    }
  }

  private isCurrent(flight: Flight<Key, Scope>): boolean {
    return !this.disposed && this.scope === flight.scope && this.generation === flight.generation;
  }

  private isEligible(flight: Flight<Key, Scope>): boolean {
    return this.options.isEligible?.(flight.key, flight.scope) ?? true;
  }

  private canRun(flight: Flight<Key, Scope>): boolean {
    return this.canAccept(flight);
  }

  private canAccept(flight: Flight<Key, Scope>): boolean {
    return this.isCurrent(flight) && this.wanted.has(flight.key) && this.isEligible(flight);
  }
}
