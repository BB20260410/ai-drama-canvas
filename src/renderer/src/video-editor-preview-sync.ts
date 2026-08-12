import { nextTick } from "vue";

export interface VideoEditorPreviewSyncScheduler {
  /**
   * Requests one deferred preview sync.  Requests made within the same flush
   * batch are coalesced into a single execution; once that execution runs the
   * scheduler rearms, so the next batch can schedule again.  The returned
   * promise resolves after the batch's sync has executed (or immediately when
   * the scheduler is already invalidated).
   */
  request(): Promise<void>;
  /**
   * Drops the queued task and rejects all future requests.  Called on unmount
   * so late tasks never run against a torn-down component.
   */
  invalidate(): void;
}

/**
 * Single scheduling owner for deferred preview syncs.  The playback tick's
 * seek and the post-flush watchers on previewClip/activeDissolve/
 * activeOverlayClips used to each schedule their own syncPreview, running it
 * twice in the same tick when overlays are active; routing every deferred
 * sync through this owner keeps exactly one execution per flush batch without
 * throttling — every batch still syncs, so drift correction is unchanged.
 */
export function createVideoEditorPreviewSyncScheduler(sync: () => void): VideoEditorPreviewSyncScheduler {
  let valid = true;
  let pending: Promise<void> | null = null;
  return {
    request() {
      if (!valid) return Promise.resolve();
      if (!pending) {
        pending = nextTick(() => {
          pending = null;
          if (valid) sync();
        });
      }
      return pending;
    },
    invalidate() {
      valid = false;
    },
  };
}
