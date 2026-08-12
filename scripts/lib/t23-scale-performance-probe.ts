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

export interface T23ScaleRendererProbeEvidenceInput extends T23ScaleRendererProbeSnapshot {
  loading?: boolean;
  corePassUnitIds?: string[];
  referenceCount?: number;
  referenceUnitIds?: string[];
  raws: Array<T23ScaleRendererProbeSnapshot["raws"][number] & {
    provenance?: string;
  }>;
  references: Array<T23ScaleRendererProbeSnapshot["references"][number] & {
    referenceId?: string;
    referenceType?: string;
  }>;
}

export interface T23ScaleRendererProbeEvidenceSnapshot {
  loading?: boolean;
  unitNodeIds: string[];
  corePassUnitIds?: string[];
  referenceCount?: number;
  referenceUnitIds?: string[];
  raws: Array<{
    unitId: string;
    rawMediaSha256: string;
    verification: string;
    provenance?: string;
    thumbnailAvailable: boolean;
  }>;
  references: Array<{
    unitId: string;
    referenceId?: string;
    mediaSha256: string;
    referenceType?: string;
    thumbnailAvailable: boolean;
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

export interface T23ScaleExpectedPassBinding {
  unitId: string;
  rawMediaSha256: string;
  referenceMediaSha256: string;
}

export interface T23ScaleExactBindingProjection {
  rawThumbnailUrls: string[];
  referenceThumbnailUrls: string[];
}

function uniqueNonEmpty(values: readonly (string | undefined)[]): number {
  return new Set(values.filter((value): value is string => Boolean(value?.trim()))).size;
}

/**
 * 只把证明绑定关系所需的匿名字段写入持久证据。
 *
 * Renderer 的缩略图 URL 带有 projectRoot 查询参数，只能在当前进程中用于解码，
 * 不得进入报告。未知扩展字段也不会被透传，避免未来 hook 增字段后意外泄露路径。
 */
export function redactT23ScaleRendererProbeForEvidence(
  snapshot: T23ScaleRendererProbeEvidenceInput,
): T23ScaleRendererProbeEvidenceSnapshot {
  return {
    ...(typeof snapshot.loading === "boolean" ? { loading: snapshot.loading } : {}),
    unitNodeIds: [...snapshot.unitNodeIds],
    ...(snapshot.corePassUnitIds ? { corePassUnitIds: [...snapshot.corePassUnitIds] } : {}),
    ...(typeof snapshot.referenceCount === "number"
      ? { referenceCount: snapshot.referenceCount }
      : {}),
    ...(snapshot.referenceUnitIds ? { referenceUnitIds: [...snapshot.referenceUnitIds] } : {}),
    raws: snapshot.raws.map((raw) => ({
      unitId: raw.unitId,
      rawMediaSha256: raw.rawMediaSha256,
      verification: raw.verification,
      ...(raw.provenance ? { provenance: raw.provenance } : {}),
      thumbnailAvailable: Boolean(raw.thumbnailUrl?.trim()),
    })),
    references: snapshot.references.map((reference) => ({
      unitId: reference.unitId,
      ...(reference.referenceId ? { referenceId: reference.referenceId } : {}),
      mediaSha256: reference.mediaSha256,
      ...(reference.referenceType ? { referenceType: reference.referenceType } : {}),
      thumbnailAvailable: Boolean(reference.thumbnailUrl?.trim()),
    })),
  };
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

/**
 * 逐单元核对 fixture 的正式 raw 与唯一冻结参考，防止四个 SHA 仅集合相等但串位。
 * 返回值只包含已经精确匹配的缩略图 URL，供浏览器做实际 decode。
 */
export function assertT23ScaleExactPassBindings(
  snapshot: T23ScaleRendererProbeSnapshot,
  expectedBindings: readonly T23ScaleExpectedPassBinding[],
): T23ScaleExactBindingProjection {
  const expectedUnitIds = new Set(expectedBindings.map((binding) => binding.unitId));
  if (!expectedBindings.length || expectedUnitIds.size !== expectedBindings.length) {
    throw new Error("T23 fixture 单元绑定必须非空且 unitId 唯一。");
  }

  const rawThumbnailUrls: string[] = [];
  const referenceThumbnailUrls: string[] = [];
  for (const expected of expectedBindings) {
    const raws = snapshot.raws.filter((raw) => raw.unitId === expected.unitId);
    if (raws.length !== 1
      || raws[0]!.rawMediaSha256 !== expected.rawMediaSha256
      || raws[0]!.verification !== "deep-verified"
      || !raws[0]!.thumbnailUrl?.trim()) {
      throw new Error(`T23 ${expected.unitId} 正式 raw 绑定或深核验不一致。`);
    }
    const references = snapshot.references.filter((reference) => reference.unitId === expected.unitId);
    if (references.length !== 1
      || references[0]!.mediaSha256 !== expected.referenceMediaSha256
      || !references[0]!.thumbnailUrl?.trim()) {
      throw new Error(`T23 ${expected.unitId} 冻结参考绑定或缩略图不一致。`);
    }
    rawThumbnailUrls.push(raws[0]!.thumbnailUrl!);
    referenceThumbnailUrls.push(references[0]!.thumbnailUrl!);
  }
  return { rawThumbnailUrls, referenceThumbnailUrls };
}
