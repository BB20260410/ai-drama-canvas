export interface T23ExpectedRaw {
  unitId: string;
  mediaSha256: string;
}

export interface T23ObservedRaw {
  unitId: string;
  mediaSha256: string;
  source?: string;
}

export interface T23RawShaComparison {
  ok: boolean;
  expectedCount: number;
  observedUnitCount: number;
  matchedCount: number;
  missingUnitIds: string[];
  strayUnitIds: string[];
  invalidExpectedUnitIds: string[];
  invalidObserved: T23ObservedRaw[];
  mismatches: Array<{
    unitId: string;
    expectedSha256: string;
    observedSha256: string[];
  }>;
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

export interface T23RawVisualDecode {
  unitId: string;
  status: "PASS" | "FAIL" | "SKIP";
  naturalWidth: number;
  naturalHeight: number;
  reason?: string;
  url?: string;
}

export function summarizeT23RawVisualDecode(
  expectedUnitIds: readonly string[],
  visuals: readonly T23RawVisualDecode[],
): {
  ok: boolean;
  passed: number;
  failed: number;
  skipped: number;
  missingUnitIds: string[];
  items: T23RawVisualDecode[];
} {
  const expected = [...new Set(expectedUnitIds.map((unitId) => unitId.trim()).filter(Boolean))].sort();
  const byUnit = new Map(visuals.map((item) => [item.unitId, item]));
  const missingUnitIds = expected.filter((unitId) => !byUnit.has(unitId));
  const items = expected.flatMap((unitId) => {
    const item = byUnit.get(unitId);
    return item ? [item] : [];
  });
  const passed = items.filter((item) => (
    item.status === "PASS" && item.naturalWidth > 0 && item.naturalHeight > 0
  )).length;
  const failed = items.filter((item) => item.status === "FAIL").length;
  const skipped = items.filter((item) => item.status === "SKIP").length;
  return {
    ok: missingUnitIds.length === 0
      && passed === expected.length
      && failed === 0
      && skipped === 0,
    passed,
    failed,
    skipped,
    missingUnitIds,
    items,
  };
}

/**
 * Core PASS 集合与 UI raw 集合必须全等：
 * - 每个 PASS 单元恰有一个合法 raw SHA；
 * - UI 不得缺失、串集、夹带非 PASS raw；
 * - 同一单元即使 DOM/管道快照重复观测，唯一 SHA 仍只能有一个并与 Core 一致。
 */
export function compareT23RawShaProjection(
  expectedRows: T23ExpectedRaw[],
  observedRows: T23ObservedRaw[],
): T23RawShaComparison {
  const expected = new Map<string, string>();
  const invalidExpectedUnitIds = new Set<string>();
  for (const row of expectedRows) {
    const unitId = row.unitId.trim();
    const sha = row.mediaSha256.trim().toLowerCase();
    if (!unitId || !SHA256_PATTERN.test(sha) || expected.has(unitId)) {
      invalidExpectedUnitIds.add(unitId || "(empty)");
      continue;
    }
    expected.set(unitId, sha);
  }

  const invalidObserved: T23ObservedRaw[] = [];
  const observed = new Map<string, Set<string>>();
  for (const row of observedRows) {
    const unitId = row.unitId.trim();
    const sha = row.mediaSha256.trim().toLowerCase();
    if (!unitId || !SHA256_PATTERN.test(sha)) {
      invalidObserved.push(row);
      continue;
    }
    const values = observed.get(unitId) ?? new Set<string>();
    values.add(sha);
    observed.set(unitId, values);
  }

  const missingUnitIds = [...expected.keys()].filter((unitId) => !observed.has(unitId)).sort();
  const strayUnitIds = [...observed.keys()].filter((unitId) => !expected.has(unitId)).sort();
  const mismatches: T23RawShaComparison["mismatches"] = [];
  let matchedCount = 0;
  for (const [unitId, expectedSha256] of expected) {
    const values = [...(observed.get(unitId) ?? [])].sort();
    if (values.length === 1 && values[0] === expectedSha256) {
      matchedCount += 1;
      continue;
    }
    if (values.length) mismatches.push({ unitId, expectedSha256, observedSha256: values });
  }

  return {
    ok: invalidExpectedUnitIds.size === 0
      && invalidObserved.length === 0
      && missingUnitIds.length === 0
      && strayUnitIds.length === 0
      && mismatches.length === 0
      && matchedCount === expected.size,
    expectedCount: expected.size,
    observedUnitCount: observed.size,
    matchedCount,
    missingUnitIds,
    strayUnitIds,
    invalidExpectedUnitIds: [...invalidExpectedUnitIds].sort(),
    invalidObserved,
    mismatches,
  };
}
