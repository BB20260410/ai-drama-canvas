/**
 * Wave 5-E：verifiedFileCache 按 canonicalRoot（工程）分桶。
 * 全局上限仍是 2048，禁止把加大上限当成优化。
 * 超限时优先淘汰其他工程最旧条目，当前工程最后才被挤。
 */

export const VERIFIED_FILE_CACHE_LIMIT = 2_048;

export interface VerifiedFileCacheEntry<TInspected = unknown> {
  bindingKey: string;
  lookupKey: string;
  canonicalRoot: string;
  inspected: TInspected;
  expectedSha256: string;
  expectedSize: number;
  target?: string;
  canonicalPath?: string;
  recordIdentity?: string;
}

interface VerificationBucket {
  cache: Map<string, VerifiedFileCacheEntry>;
  lookup: Map<string, string>;
}

const buckets = new Map<string, VerificationBucket>();

function bucketOf(canonicalRoot: string): VerificationBucket {
  let bucket = buckets.get(canonicalRoot);
  if (!bucket) {
    bucket = { cache: new Map(), lookup: new Map() };
    buckets.set(canonicalRoot, bucket);
  }
  return bucket;
}

export function verifiedFileCacheSize(): number {
  let size = 0;
  for (const bucket of buckets.values()) size += bucket.cache.size;
  return size;
}

export function verifiedFileCacheBucketCount(): number {
  return buckets.size;
}

function evictOldestFromBucket(canonicalRoot: string): boolean {
  const bucket = buckets.get(canonicalRoot);
  if (!bucket || bucket.cache.size === 0) return false;
  const oldestBinding = bucket.cache.keys().next().value;
  if (typeof oldestBinding !== "string") return false;
  const oldest = bucket.cache.get(oldestBinding);
  bucket.cache.delete(oldestBinding);
  if (oldest && bucket.lookup.get(oldest.lookupKey) === oldestBinding) bucket.lookup.delete(oldest.lookupKey);
  if (bucket.cache.size === 0) buckets.delete(canonicalRoot);
  return true;
}

function pickVictimRoot(currentRoot: string): string | undefined {
  for (const [root, bucket] of buckets) {
    if (root !== currentRoot && bucket.cache.size > 0) return root;
  }
  const current = buckets.get(currentRoot);
  if (current && current.cache.size > 0) return currentRoot;
  return undefined;
}

export function getVerifiedFileLookup(canonicalRoot: string, lookupKey: string): string | undefined {
  return buckets.get(canonicalRoot)?.lookup.get(lookupKey);
}

export function getVerifiedFile<TInspected>(
  canonicalRoot: string,
  bindingKey: string,
): VerifiedFileCacheEntry<TInspected> | undefined {
  return buckets.get(canonicalRoot)?.cache.get(bindingKey) as VerifiedFileCacheEntry<TInspected> | undefined;
}

export function deleteDanglingVerifiedFileLookup(canonicalRoot: string, lookupKey: string): void {
  buckets.get(canonicalRoot)?.lookup.delete(lookupKey);
}

export function touchVerifiedFile(entry: VerifiedFileCacheEntry): void {
  const bucket = buckets.get(entry.canonicalRoot);
  if (!bucket?.cache.has(entry.bindingKey)) return;
  bucket.cache.delete(entry.bindingKey);
  bucket.cache.set(entry.bindingKey, entry);
}

export function rememberVerifiedFile(entry: VerifiedFileCacheEntry): number {
  const bucket = bucketOf(entry.canonicalRoot);
  const previousBinding = bucket.lookup.get(entry.lookupKey);
  if (previousBinding && previousBinding !== entry.bindingKey) bucket.cache.delete(previousBinding);
  bucket.cache.delete(entry.bindingKey);
  bucket.cache.set(entry.bindingKey, entry);
  bucket.lookup.set(entry.lookupKey, entry.bindingKey);
  let evicted = 0;
  while (verifiedFileCacheSize() > VERIFIED_FILE_CACHE_LIMIT) {
    const victim = pickVictimRoot(entry.canonicalRoot);
    if (!victim || !evictOldestFromBucket(victim)) break;
    evicted += 1;
  }
  return evicted;
}

export function evictVerifiedFileCacheForProject(canonicalRoot: string): number {
  const bucket = buckets.get(canonicalRoot);
  if (!bucket) return 0;
  const removed = bucket.cache.size;
  buckets.delete(canonicalRoot);
  return removed;
}

export function resetVerifiedFileCacheForTests(): void {
  buckets.clear();
}
