import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const projectRoot = path.resolve(process.argv[2] ?? path.join(process.cwd(), "productions", "gushujuan-s3-f1a688020bfb7af6"));
const sidecarRoot = path.join(projectRoot, ".aicanvas");

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right, "en"))
    .map(([key, entry]) => [key, stableValue(entry)]));
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(stableValue(value))).digest("hex");
}

const [index, catalog, canonical] = await Promise.all([
  readFile(path.join(sidecarRoot, "index.json"), "utf8").then(JSON.parse),
  readFile(path.join(sidecarRoot, "production-assets.json"), "utf8").then(JSON.parse),
  readFile(path.join(sidecarRoot, "canonical-assets.json"), "utf8").then(JSON.parse),
]);
const workItemIds = new Set<string>(catalog.assets.map((entry: { workItemId: string }) => entry.workItemId));
const expected = canonical.sourceSnapshot.files.find((entry: { role: string }) => entry.role === "index").semanticSha256;

function semanticIndexFromRecords(
  rawIndex: Record<string, any>,
  authoritativeChoice: "true" | "false" | "first",
  deduplicateItemIds: boolean,
  hardLocks: "current" | "empty",
  sortItemArtifactIds = false,
) {
  const groups = new Map<string, Array<Record<string, unknown>>>();
  for (const artifact of rawIndex.artifacts as Array<Record<string, unknown>>) {
    if (!workItemIds.has(artifact.itemId as string)) continue;
    groups.set(artifact.id as string, [...(groups.get(artifact.id as string) ?? []), artifact]);
  }
  const artifacts = [...groups.values()].map((entries) => {
    if (authoritativeChoice === "true") return entries.find((entry) => entry.authoritative === true) ?? entries[0]!;
    if (authoritativeChoice === "false") return entries.find((entry) => entry.authoritative === false) ?? entries[0]!;
    return entries[0]!;
  }).map((artifact) => ({
    id: artifact.id,
    itemId: artifact.itemId,
    path: artifact.path,
    rootSlot: artifact.rootSlot,
    relativePath: artifact.relativePath,
    kind: artifact.kind,
    variant: artifact.variant,
    deprecated: artifact.deprecated,
    authoritative: artifact.authoritative,
    check: {
      ok: (artifact.check as Record<string, unknown>).ok,
      exists: (artifact.check as Record<string, unknown>).exists,
      decodable: (artifact.check as Record<string, unknown>).decodable,
      width: (artifact.check as Record<string, unknown>).width,
      height: (artifact.check as Record<string, unknown>).height,
      size: (artifact.check as Record<string, unknown>).size,
      sha256: (artifact.check as Record<string, unknown>).sha256,
      issues: (artifact.check as Record<string, unknown>).issues,
    },
  })).sort((left, right) => String(left.id).localeCompare(String(right.id), "en"));
  const items = (rawIndex.items as Array<Record<string, unknown>>)
    .filter((item) => workItemIds.has(item.id as string))
    .map((item) => ({
      id: item.id,
      type: item.type,
      artifactIds: (sortItemArtifactIds
        ? [...new Set(item.artifactIds as string[])].sort((left, right) => left.localeCompare(right, "en"))
        : deduplicateItemIds ? [...new Set(item.artifactIds as string[])] : item.artifactIds),
      hardLockIds: hardLocks === "empty" ? [] : item.hardLockIds,
    }))
    .sort((left, right) => String(left.id).localeCompare(String(right.id), "en"));
  return { projectId: rawIndex.project.id, items, artifacts };
}

function semanticIndex(authoritativeChoice: "true" | "false" | "first", deduplicateItemIds: boolean, hardLocks: "current" | "empty", sortItemArtifactIds = false) {
  return semanticIndexFromRecords(index, authoritativeChoice, deduplicateItemIds, hardLocks, sortItemArtifactIds);
}

const database = new DatabaseSync(path.join(sidecarRoot, "cache.sqlite"), { readOnly: true });
const cacheIndex = {
  project: index.project,
  items: database.prepare("SELECT payload FROM items").all().map((row) => JSON.parse(String((row as { payload: string }).payload))),
  artifacts: database.prepare("SELECT payload FROM artifacts").all().map((row) => JSON.parse(String((row as { payload: string }).payload))),
};
database.close();
const cacheSemantic = semanticIndexFromRecords(cacheIndex, "first", false, "current");
const cacheHash = digest(cacheSemantic);
const normalizedCurrent = semanticIndex("true", true, "current", true);
const normalizedCache = semanticIndexFromRecords(cacheIndex, "first", true, "current", true);

const variants = (["true", "false", "first"] as const).flatMap((authoritativeChoice) =>
  ([true, false] as const).flatMap((deduplicateItemIds) =>
    (["current", "empty"] as const).map((hardLocks) => {
      const actual = digest(semanticIndex(authoritativeChoice, deduplicateItemIds, hardLocks));
      return { authoritativeChoice, deduplicateItemIds, hardLocks, actual, matches: actual === expected };
    })));
process.stdout.write(`${JSON.stringify({
  expected,
  cache: {
    actual: cacheHash,
    matches: cacheHash === expected,
    normalizedActual: digest(normalizedCache),
    normalizedMatchesCurrent: digest(normalizedCache) === digest(normalizedCurrent),
  },
  current: { normalizedActual: digest(normalizedCurrent) },
  variants,
}, null, 2)}\n`);
