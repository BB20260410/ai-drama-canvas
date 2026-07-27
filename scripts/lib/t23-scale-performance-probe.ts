export interface T23ScaleRendererProbeSnapshot {
  unitNodeIds: string[];
  raws: Array<{
    unitId: string;
    rawMediaSha256: string;
    thumbnailUrl?: string;
    verification: string;
  }>;
  references: Array<{
    unitId: string;
    mediaSha256: string;
    thumbnailUrl?: string;
  }>;
}

export interface T23ScaleRendererProbeSummary {
  projectedUnitNodeCount: number;
  uniqueProjectedUnitNodeCount: number;
  passRawCount: number;
  uniqueRawShaCount: number;
  uniqueRawUrlCount: number;
  referenceCount: number;
  uniqueReferenceShaCount: number;
  uniqueReferenceUrlCount: number;
}

function uniqueNonEmpty(values: readonly (string | undefined)[]): number {
  return new Set(values.filter((value): value is string => Boolean(value?.trim()))).size;
}

/**
 * 把 renderer 只读 hook 的真实图节点、raw 与冻结参考压成硬门测量。
 *
 * 这里故意不接受后端 overview/unitCount：unitNodeIds 必须直接来自当前 VueFlow
 * `nodes` store，才能证明 36 个单元确实进入了画布投影，而不是只在 metrics 中存在。
 */
export function summarizeT23ScaleRendererProbe(
  snapshot: T23ScaleRendererProbeSnapshot,
  passUnitIds: readonly string[],
): T23ScaleRendererProbeSummary {
  const passUnits = new Set(passUnitIds);
  const raws = snapshot.raws.filter((raw) => (
    passUnits.has(raw.unitId) && raw.verification === "deep-verified"
  ));
  const references = snapshot.references.filter((reference) => passUnits.has(reference.unitId));
  return {
    projectedUnitNodeCount: snapshot.unitNodeIds.length,
    uniqueProjectedUnitNodeCount: uniqueNonEmpty(snapshot.unitNodeIds),
    passRawCount: raws.length,
    uniqueRawShaCount: uniqueNonEmpty(raws.map((raw) => raw.rawMediaSha256)),
    uniqueRawUrlCount: uniqueNonEmpty(raws.map((raw) => raw.thumbnailUrl)),
    referenceCount: references.length,
    uniqueReferenceShaCount: uniqueNonEmpty(references.map((reference) => reference.mediaSha256)),
    uniqueReferenceUrlCount: uniqueNonEmpty(references.map((reference) => reference.thumbnailUrl)),
  };
}
