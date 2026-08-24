export interface StudioMultimediaPlaybackEntryIdentity {
  readonly id: string;
}

export function findSelectedStudioMultimediaPlaybackEntry<
  TEntry extends StudioMultimediaPlaybackEntryIdentity,
>(entries: readonly TEntry[], selectedId: string): TEntry | null {
  if (!selectedId) return null;
  return entries.find((entry) => entry.id === selectedId) ?? null;
}

export function retainStudioMultimediaPlaybackSelection(
  entries: readonly StudioMultimediaPlaybackEntryIdentity[],
  selectedId: string,
): string {
  if (!selectedId) return "";
  return entries.some((entry) => entry.id === selectedId) ? selectedId : "";
}
