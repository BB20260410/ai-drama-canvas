/**
 * 《嘟嘟》S1E1 外部锁版包的只读解析层。
 *
 * 本模块只读取、验 SHA、解析结构化字段并冻结 source manifest；不创建工程、
 * 不写 Studio/CAS，也不修改外部生产根。导入编排必须消费本模块的完整检查结果。
 */
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const UNIT_PATTERN = /^## (S1E01-U\d{2}) · ([0-9.]+)s · (\d+)宫格 · (.+)$/gmu;
const PANEL_PATTERN = /^### (S1E01-U\d{2}-G(\d+)) · ([0-9.]+)s\s*$/gmu;
const FIXED_UNIT_IDS = Array.from({ length: 33 }, (_, index) => `S1E01-U${String(index).padStart(2, "0")}`);
export const DUDU_VISUAL_EXECUTION_RELATIVE_PATH = "00_视觉正典_v2/episodes/S1E1_树下的家_视觉执行v2.md";

export interface DuduReadonlySourceInput {
  lockedScriptPath: string;
  productionRoot: string;
  contractRelativePath?: string;
  machineStateRelativePath?: string;
  referenceRegistryRelativePath?: string;
  visualCanonRevisionRelativePath?: string;
  visualExecutionRelativePath?: string;
  visualConflictDecisionRelativePath?: string;
  meteorVfxRuleRelativePath?: string;
}

export interface DuduSourceFileIdentity {
  scope: "locked-source" | "production-root";
  relativePath: string;
  absolutePath: string;
  sha256: string;
  sizeBytes: number;
}

export type DuduStudioAssetCategory = "character" | "scene" | "prop";

export interface DuduReferenceAsset {
  id: string;
  name: string;
  category: DuduStudioAssetCategory;
  sourceType: string;
  referenceRole: string;
  relativePath: string;
  absolutePath: string;
  sha256: string;
  status: "APPROVED" | "APPROVED_WITH_P2";
  inherit: string;
  forbid: string;
  aliases: string[];
}

export interface DuduParsedPanel {
  id: string;
  index: number;
  durationSeconds: number;
  startSeconds: number;
  endSeconds: number;
  sourceStartOffsetUtf16: number;
  sourceEndOffsetUtf16: number;
  fields: Record<string, string>;
  sourceText: string;
}

export interface DuduFrozenVisualExecutionUnit {
  unitId: string;
  sequence: number;
  title: string;
  durationSeconds: number;
  panelCount: number;
  panels: DuduParsedPanel[];
  source: DuduSourceFileIdentity;
}

export interface DuduHistoricalPassSource {
  raw: DuduSourceFileIdentity;
  labeled: DuduSourceFileIdentity;
  qc: DuduSourceFileIdentity;
  manifest: DuduSourceFileIdentity;
  packageFiles: DuduSourceFileIdentity[];
  videoPackStatus: string;
  i2vReadiness: string;
  externalStoryboardStatus: "PASS" | "PASS_WITH_P2";
}

export interface DuduForbiddenReference {
  asset: DuduReferenceAsset;
  /**
   * 1-based 格号；A/E 先建立整单元禁见边界，再只投影到锁版原文中能以角色词或
   * 画外关系词唯一锚定的格。整张宫格仍逐字继承 E. raw 总合同。
   */
  panelIndexes: number[];
  evidence: Array<{
    section: "A" | "D" | "E";
    panelIndex?: number;
    text: string;
  }>;
}

export interface DuduReadonlyUnitSource {
  unitId: string;
  sequence: number;
  title: string;
  durationSeconds: number;
  episodeStartSeconds: number;
  episodeEndSeconds: number;
  panelCount: number;
  sourceStartOffsetUtf16: number;
  sourceEndOffsetUtf16: number;
  panels: DuduParsedPanel[];
  /** 上位 visual-execution-v2.1 的可执行视觉字段；锁版 spans 仍以 panels 为准。 */
  visualExecutionPanels: DuduParsedPanel[];
  machineState: Record<string, unknown>;
  binding: {
    format: "legacy" | "v2";
    file: DuduSourceFileIdentity;
    body: string;
    /** v2 BindingSet 的 E. raw 宫格提示词；逐字去除可选 Markdown fence 后冻结。 */
    rawGridPrompt?: string;
    lifecycle: "FROZEN_READY" | "HISTORICAL_PASS_ONLY";
    version: string;
    attemptBudget: number | null;
    generationRecord?: DuduSourceFileIdentity & { body: string };
  } | null;
  /** A/D/E 明确声明画外或禁止入画、且不属于 B. 正向图片参考的已知角色。 */
  forbiddenReferences: DuduForbiddenReference[];
  references: DuduReferenceAsset[];
  historicalPass: DuduHistoricalPassSource | null;
}

export interface DuduSourceConflictDiagnostic {
  code:
    | "U00_STALE_TWO_GRID_SUMMARY"
    | "LOCKED_VISUAL_TERMS_OVERRIDDEN_BY_V21"
    | "HISTORICAL_P2_PROJECTION_MERGED"
    | "BINDING_MACHINE_PROJECTION_STALE";
  unitId?: string;
  resolution: string;
  evidence: string[];
}

export interface DuduComputedProductionProjection {
  historicalStoryboardPassUnitIds: string[];
  bindingReadyUnitIds: string[];
  missingBindingUnitIds: string[];
  pendingStoryboardUnitIds: string[];
  earliestStoryboardPending: string | null;
  earliestBindingReadyPending: string | null;
  earliestMissingBinding: string | null;
}

export interface DuduReadonlySourceInspection {
  schemaVersion: 1;
  kind: "dudu-readonly-source-inspection";
  lockedScript: DuduSourceFileIdentity & { body: string };
  contract: DuduSourceFileIdentity & { body: string };
  visualCanonRevision: DuduSourceFileIdentity & { body: string };
  visualExecution: DuduSourceFileIdentity & { body: string };
  visualConflictDecision: DuduSourceFileIdentity & { body: string };
  meteorVfxRule: DuduSourceFileIdentity & { body: string };
  machineStateFile: DuduSourceFileIdentity;
  referenceRegistryFile: DuduSourceFileIdentity;
  lockedScriptPath: string;
  productionRoot: string;
  unitIds: string[];
  units: DuduReadonlyUnitSource[];
  referenceAssets: DuduReferenceAsset[];
  sourceFiles: DuduSourceFileIdentity[];
  sourceManifestFingerprint: string;
  productionScopeFingerprint: string;
  conflicts: DuduSourceConflictDiagnostic[];
  computedProjection: DuduComputedProductionProjection;
  summary: {
    unitCount: 33;
    totalDurationSeconds: 492;
    panelCount: number;
    bindingCount: 30;
    historicalPassCount: 28;
    approvedRawCount: 28;
    contractMinReferences: 1;
    contractMaxReferences: 5;
    actualMinReferences: number;
    actualMaxReferences: number;
  };
}

export interface DuduCurrentMachineProjectionExpectedUnit {
  unitId: string;
  sequence: number;
  durationSeconds: number;
  panelCount: number;
  initialStoryboardStatus: string;
  initialToolInvocationCount: number;
  initialVisualCandidateCount: number;
  historicalApprovedRawRelativePath: string | null;
  historicalApprovedRawSha256: string | null;
}

export interface DuduCurrentMachineProjection {
  schemaVersion: 1;
  kind: "dudu-current-machine-projection";
  file: DuduSourceFileIdentity;
  units: Array<{
    unitId: string;
    sequence: number;
    durationSeconds: number;
    panelCount: number;
    storyboardStatus: string;
    rawQcStatus: string;
    preparationStatus: string;
    generationStatus: string;
    toolInvocationCount: number;
    visualCandidateCount: number;
    rejectedCandidateCount: number;
    approvedRawRelativePath: string | null;
    approvedRawSha256: string | null;
  }>;
  summary: {
    unitCount: 33;
    storyboardPassCount: number;
    earliestStoryboardPending: string | null;
  };
  fingerprint: string;
}

interface RegistryAssetRow {
  id?: unknown;
  type?: unknown;
  reference_role?: unknown;
  file?: unknown;
  sha256?: unknown;
  status?: unknown;
  inherit?: unknown;
  forbid?: unknown;
}

interface RegistryPayload {
  max_referenced_image_paths_per_call?: unknown;
  assets?: unknown;
}

interface MachineUnitRow extends Record<string, unknown> {
  unit_id?: unknown;
  duration_sec?: unknown;
  panel_count?: unknown;
  storyboard_status?: unknown;
  raw_qc_status?: unknown;
  approved_raw_path?: unknown;
  approved_raw_sha256?: unknown;
  preparation_status?: unknown;
  generation_status?: unknown;
  video_pack_status?: unknown;
  continuity_status?: unknown;
  overall_status?: unknown;
  tool_invocation_count?: unknown;
  visual_candidate_count?: unknown;
  rejected_candidates?: unknown;
  evidence?: unknown;
}

interface MachinePayload {
  summary?: unknown;
  units?: unknown;
}

interface VideoManifestFileRow {
  path?: unknown;
  sha256?: unknown;
}

interface VideoManifestPayload {
  manifest_version?: unknown;
  spec_schema_version?: unknown;
  builder?: unknown;
  unit_id?: unknown;
  status?: unknown;
  i2v_readiness?: unknown;
  source_spec?: VideoManifestFileRow;
  raw?: VideoManifestFileRow;
  files?: unknown;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right, "en"))
    .map(([key, entry]) => [key, stableValue(entry)]));
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(stableValue(value)), "utf8").digest("hex");
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} 不能为空。`);
  return value.normalize("NFC").trim();
}

function requiredInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`${field} 必须是非负整数。`);
  return Number(value);
}

function requiredSha(value: unknown, field: string): string {
  const normalized = requiredText(value, field).toLowerCase();
  if (!SHA256_PATTERN.test(normalized)) throw new Error(`${field} 必须是 64 位 SHA-256。`);
  return normalized;
}

function pathInside(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function assertCanonicalDirectory(directory: string, field: string): Promise<string> {
  const resolved = path.resolve(directory);
  const metadata = await lstat(resolved);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new Error(`${field} 必须是无符号链接的真实目录。`);
  const canonical = await realpath(resolved);
  if (canonical !== resolved) throw new Error(`${field} 真实路径与输入不一致，拒绝经符号链接导入：${resolved}`);
  return canonical;
}

async function readStableFile(
  absolutePath: string,
  scope: DuduSourceFileIdentity["scope"],
  relativePath: string,
  expectedSha256?: string,
): Promise<{ identity: DuduSourceFileIdentity; bytes: Buffer }> {
  const resolved = path.resolve(absolutePath);
  const pathBefore = await lstat(resolved, { bigint: true });
  if (pathBefore.isSymbolicLink() || !pathBefore.isFile()) throw new Error(`只读来源必须是无符号链接的普通文件：${resolved}`);
  if (await realpath(resolved) !== resolved) throw new Error(`只读来源路径包含符号链接：${resolved}`);
  const handle = await open(resolved, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  let bytes: Buffer;
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.dev !== pathBefore.dev || before.ino !== pathBefore.ino) {
      throw new Error(`只读来源在打开前被替换：${resolved}`);
    }
    bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    const pathAfter = await lstat(resolved, { bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs
      || after.dev !== pathAfter.dev || after.ino !== pathAfter.ino || after.size !== pathAfter.size
      || after.mtimeNs !== pathAfter.mtimeNs || after.ctimeNs !== pathAfter.ctimeNs
      || pathAfter.isSymbolicLink() || !pathAfter.isFile()
      || bytes.byteLength !== Number(after.size)
      || await realpath(resolved) !== resolved) {
      throw new Error(`只读来源在读取期间发生漂移：${resolved}`);
    }
  } finally {
    await handle.close();
  }
  const actualSha256 = sha256(bytes);
  if (expectedSha256 && actualSha256 !== expectedSha256) {
    throw new Error(`只读来源 SHA 不匹配：${relativePath}；expected=${expectedSha256} actual=${actualSha256}`);
  }
  return {
    identity: {
      scope,
      relativePath: relativePath.split(path.sep).join("/"),
      absolutePath: resolved,
      sha256: actualSha256,
      sizeBytes: bytes.byteLength,
    },
    bytes,
  };
}

function normalizedOptionalProductionRelativePath(value: unknown, field: string): string | null {
  if (value === null || value === undefined || value === "") return null;
  const normalized = requiredText(value, field).split(path.sep).join("/");
  if (path.posix.isAbsolute(normalized) || path.posix.normalize(normalized) !== normalized
    || normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`${field} 必须是生产根内的规范相对路径。`);
  }
  return normalized;
}

function isStoryboardPass(value: string): boolean {
  return value === "PASS" || value === "PASS_WITH_P2";
}

/**
 * 活动生产动作每次都重新读取机器状态，但只允许这一份投影原位演进。这里验证固定
 * S1E1 范围、时长/格数、计数、summary 以及历史 PASS 不倒退；不把它并入不可变
 * sourceManifestFingerprint，避免受控续作后把整个导入身份误判为漂移。
 */
export async function readDuduCurrentMachineProjection(input: {
  productionRoot: string;
  machineStateRelativePath: string;
  expectedUnits: DuduCurrentMachineProjectionExpectedUnit[];
}): Promise<DuduCurrentMachineProjection> {
  const productionRoot = await assertCanonicalDirectory(input.productionRoot, "productionRoot");
  const relativePath = input.machineStateRelativePath.split(path.sep).join("/");
  const expected = [...input.expectedUnits].sort((left, right) => left.sequence - right.sequence);
  if (expected.length !== 33 || expected.some((unit, index) => unit.unitId !== FIXED_UNIT_IDS[index]
    || unit.sequence !== index + 1 || !Number.isSafeInteger(unit.panelCount) || unit.panelCount < 1
    || !Number.isFinite(unit.durationSeconds) || unit.durationSeconds <= 0
    || !Number.isSafeInteger(unit.initialToolInvocationCount) || unit.initialToolInvocationCount < 0
    || !Number.isSafeInteger(unit.initialVisualCandidateCount) || unit.initialVisualCandidateCount < 0
    || unit.initialVisualCandidateCount > unit.initialToolInvocationCount
    || (unit.historicalApprovedRawRelativePath === null) !== (unit.historicalApprovedRawSha256 === null)
    || (unit.historicalApprovedRawSha256 !== null && !SHA256_PATTERN.test(unit.historicalApprovedRawSha256)))) {
    throw new Error("Dudu 当前机器投影的不可变单元期望无效。 ");
  }
  const machineRead = await readStableFile(
    productionPath(productionRoot, relativePath),
    "production-root",
    relativePath,
  );
  const machine = parseJsonObject(machineRead.bytes, "当前机器状态") as MachinePayload;
  const rows = Array.isArray(machine.units) ? machine.units as MachineUnitRow[] : [];
  if (rows.length !== 33) throw new Error(`当前机器状态单元数应为 33，实际 ${rows.length}。`);
  const seen = new Set<string>();
  const units = rows.map((row, index): DuduCurrentMachineProjection["units"][number] => {
    const unitId = requiredText(row.unit_id, `machine.units[${index}].unit_id`);
    if (seen.has(unitId)) throw new Error(`当前机器状态包含重复单元：${unitId}`);
    seen.add(unitId);
    const expectedUnit = expected[index];
    if (!expectedUnit || unitId !== expectedUnit.unitId) {
      throw new Error(`当前机器状态单元顺序/范围漂移：index=${index} actual=${unitId}`);
    }
    const durationSeconds = Number(row.duration_sec);
    const panelCount = Number(row.panel_count);
    if (durationSeconds !== expectedUnit.durationSeconds || panelCount !== expectedUnit.panelCount) {
      throw new Error(`${unitId} 当前机器状态时长/格数与导入收据不一致。`);
    }
    const storyboardStatus = requiredText(row.storyboard_status, `${unitId}.storyboard_status`);
    const rawQcStatus = requiredText(row.raw_qc_status, `${unitId}.raw_qc_status`);
    const preparationStatus = requiredText(row.preparation_status, `${unitId}.preparation_status`);
    const generationStatus = requiredText(row.generation_status, `${unitId}.generation_status`);
    const toolInvocationCount = requiredInteger(row.tool_invocation_count, `${unitId}.tool_invocation_count`);
    const visualCandidateCount = requiredInteger(row.visual_candidate_count, `${unitId}.visual_candidate_count`);
    const rejectedCandidates = Array.isArray(row.rejected_candidates) ? row.rejected_candidates : null;
    if (!rejectedCandidates || visualCandidateCount > toolInvocationCount
      || rejectedCandidates.length > visualCandidateCount
      || toolInvocationCount < expectedUnit.initialToolInvocationCount
      || visualCandidateCount < expectedUnit.initialVisualCandidateCount) {
      throw new Error(`${unitId} 当前调用/候选计数或 rejected_candidates 非法/倒退。`);
    }
    const approvedRawRelativePath = normalizedOptionalProductionRelativePath(
      row.approved_raw_path,
      `${unitId}.approved_raw_path`,
    );
    const approvedRawSha256 = row.approved_raw_sha256 === null || row.approved_raw_sha256 === undefined
      || row.approved_raw_sha256 === ""
      ? null
      : requiredSha(row.approved_raw_sha256, `${unitId}.approved_raw_sha256`);
    if ((approvedRawRelativePath === null) !== (approvedRawSha256 === null)) {
      throw new Error(`${unitId} approved raw 路径与 SHA 必须成对出现。`);
    }
    if (isStoryboardPass(storyboardStatus) && (!approvedRawRelativePath || !approvedRawSha256)) {
      throw new Error(`${unitId} storyboard PASS 缺少 approved raw 身份。`);
    }
    if (expectedUnit.historicalApprovedRawRelativePath) {
      const initialPass = expectedUnit.initialStoryboardStatus;
      if (!isStoryboardPass(storyboardStatus)
        || (initialPass === "PASS" && storyboardStatus !== "PASS")
        || approvedRawRelativePath !== expectedUnit.historicalApprovedRawRelativePath
        || approvedRawSha256 !== expectedUnit.historicalApprovedRawSha256) {
        throw new Error(`${unitId} 历史 PASS/approved raw 身份发生倒退或替换。`);
      }
    }
    return {
      unitId,
      sequence: expectedUnit.sequence,
      durationSeconds,
      panelCount,
      storyboardStatus,
      rawQcStatus,
      preparationStatus,
      generationStatus,
      toolInvocationCount,
      visualCandidateCount,
      rejectedCandidateCount: rejectedCandidates.length,
      approvedRawRelativePath,
      approvedRawSha256,
    };
  });
  if (seen.size !== 33 || FIXED_UNIT_IDS.some((unitId) => !seen.has(unitId))) {
    throw new Error("当前机器状态未精确覆盖 S1E1 U00—U32。 ");
  }
  const storyboardPassCount = units.filter((unit) => isStoryboardPass(unit.storyboardStatus)).length;
  const earliestStoryboardPending = units.find((unit) => !isStoryboardPass(unit.storyboardStatus))?.unitId ?? null;
  const summary = machine.summary && typeof machine.summary === "object" && !Array.isArray(machine.summary)
    ? machine.summary as Record<string, unknown>
    : null;
  if (!summary || summary.unit_count !== 33 || summary.storyboard_pass_count !== storyboardPassCount
    || (summary.earliest_storyboard_pending ?? null) !== earliestStoryboardPending) {
    throw new Error("当前机器 summary 与 33 单元逐行状态不一致。 ");
  }
  const semantic = {
    schemaVersion: 1 as const,
    kind: "dudu-current-machine-projection" as const,
    file: machineRead.identity,
    units,
    summary: {
      unitCount: 33 as const,
      storyboardPassCount,
      earliestStoryboardPending,
    },
  };
  return { ...semantic, fingerprint: digest(semantic) };
}

function productionPath(root: string, relativePath: string): string {
  const absolute = path.resolve(root, relativePath);
  if (!pathInside(absolute, root) || absolute === root) throw new Error(`生产包相对路径逃逸根目录：${relativePath}`);
  return absolute;
}

function parseJsonObject(bytes: Buffer, field: string): Record<string, unknown> {
  let parsed: unknown;
  try { parsed = JSON.parse(bytes.toString("utf8")); }
  catch (error) { throw new Error(`${field} 不是有效 JSON。`, { cause: error }); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${field} 必须是 JSON 对象。`);
  return parsed as Record<string, unknown>;
}

function parsePanelFields(block: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const line of block.split(/\r?\n/u)) {
    const match = /^\|\s*([^|]+?)\s*\|\s*(.*?)\s*\|\s*$/u.exec(line);
    if (!match || /^[-: ]+$/u.test(match[1]!) || match[1] === "字段") continue;
    fields[match[1]!.trim()] = match[2]!.trim();
  }
  return fields;
}

function parseScriptUnits(body: string): Array<Omit<DuduReadonlyUnitSource,
  "machineState" | "binding" | "references" | "forbiddenReferences" | "historicalPass" | "visualExecutionPanels">> {
  const unitMatches = [...body.matchAll(UNIT_PATTERN)];
  if (unitMatches.length !== FIXED_UNIT_IDS.length) throw new Error(`锁版剧本单元数应为 33，实际 ${unitMatches.length}。`);
  let episodeCursor = 0;
  return unitMatches.map((match, unitOffset) => {
    const unitId = match[1]!;
    if (unitId !== FIXED_UNIT_IDS[unitOffset]) throw new Error(`锁版剧本单元顺序漂移：expected=${FIXED_UNIT_IDS[unitOffset]} actual=${unitId}`);
    const durationSeconds = Number(match[2]);
    const panelCount = Number(match[3]);
    const unitStart = match.index!;
    const unitEnd = unitMatches[unitOffset + 1]?.index ?? body.length;
    const unitBlock = body.slice(unitStart, unitEnd);
    const panelMatches = [...unitBlock.matchAll(PANEL_PATTERN)];
    if (panelMatches.length !== panelCount) throw new Error(`${unitId} 标称 ${panelCount} 格，实际解析 ${panelMatches.length} 格。`);
    let localCursor = 0;
    const panels = panelMatches.map((panelMatch, panelOffset): DuduParsedPanel => {
      const expectedPanelId = `${unitId}-G${panelOffset + 1}`;
      if (panelMatch[1] !== expectedPanelId || Number(panelMatch[2]) !== panelOffset + 1) {
        throw new Error(`${unitId} 宫格顺序漂移：expected=${expectedPanelId} actual=${panelMatch[1]}`);
      }
      const panelDuration = Number(panelMatch[3]);
      if (!Number.isFinite(panelDuration) || panelDuration <= 0) throw new Error(`${expectedPanelId} 时长无效。`);
      const panelStart = unitStart + panelMatch.index!;
      const panelEnd = unitStart + (panelMatches[panelOffset + 1]?.index ?? unitBlock.length);
      const startSeconds = localCursor;
      localCursor += panelDuration;
      const sourceText = body.slice(panelStart, panelEnd);
      return {
        id: expectedPanelId,
        index: panelOffset + 1,
        durationSeconds: panelDuration,
        startSeconds,
        endSeconds: localCursor,
        sourceStartOffsetUtf16: panelStart,
        sourceEndOffsetUtf16: panelEnd,
        fields: parsePanelFields(sourceText),
        sourceText,
      };
    });
    if (Math.abs(localCursor - durationSeconds) > 0.000_001) {
      throw new Error(`${unitId} 逐格时长和 ${localCursor} 与单元 ${durationSeconds} 不一致。`);
    }
    const title = requiredText(match[4], `${unitId} 标题`);
    const episodeStartSeconds = episodeCursor;
    episodeCursor += durationSeconds;
    return {
      unitId,
      sequence: unitOffset + 1,
      title,
      durationSeconds,
      episodeStartSeconds,
      episodeEndSeconds: episodeCursor,
      panelCount,
      sourceStartOffsetUtf16: unitStart,
      sourceEndOffsetUtf16: unitEnd,
      panels,
    };
  });
}

/**
 * 后续确定性视频适配只读取导入时已冻结的视觉执行文件，不重扫机器状态，
 * 也不把外部新增投影补进原 source manifest。
 */
export async function readDuduFrozenVisualExecutionUnit(input: {
  productionRoot: string;
  sourceFiles: DuduSourceFileIdentity[];
  unitId: string;
}): Promise<DuduFrozenVisualExecutionUnit> {
  const productionRoot = await assertCanonicalDirectory(input.productionRoot, "Dudu productionRoot");
  const unitId = requiredText(input.unitId, "unitId");
  if (!FIXED_UNIT_IDS.includes(unitId)) throw new Error(`unitId 不在冻结 S1E1 范围：${unitId}`);
  const identities = input.sourceFiles.filter((file) => file.scope === "production-root"
    && file.relativePath === DUDU_VISUAL_EXECUTION_RELATIVE_PATH);
  if (identities.length !== 1) throw new Error("Dudu visual execution 未在 source manifest 中唯一冻结。 ");
  const expected = identities[0]!;
  const absolutePath = productionPath(productionRoot, DUDU_VISUAL_EXECUTION_RELATIVE_PATH);
  if (path.resolve(expected.absolutePath) !== absolutePath) {
    throw new Error("Dudu visual execution absolutePath 与 productionRoot 不一致。 ");
  }
  const read = await readStableFile(
    absolutePath,
    "production-root",
    DUDU_VISUAL_EXECUTION_RELATIVE_PATH,
    expected.sha256,
  );
  if (read.identity.sizeBytes !== expected.sizeBytes) throw new Error("Dudu visual execution size 与 source manifest 不一致。 ");
  const unit = parseScriptUnits(read.bytes.toString("utf8")).find((candidate) => candidate.unitId === unitId);
  if (!unit) throw new Error(`Dudu visual execution 缺少单元：${unitId}`);
  return {
    unitId: unit.unitId,
    sequence: unit.sequence,
    title: unit.title,
    durationSeconds: unit.durationSeconds,
    panelCount: unit.panelCount,
    panels: unit.panels.map((panel) => ({
      ...panel,
      fields: { ...panel.fields },
    })),
    source: { ...read.identity },
  };
}

export function duduStudioCategoryForSourceType(sourceType: string): DuduStudioAssetCategory {
  switch (sourceType) {
    case "character": return "character";
    case "scene":
    case "scene_detail":
    case "scene_rule": return "scene";
    case "prop":
    case "key_non_character_element": return "prop";
    // 冻结 P30 导入合同要求：除 character 与 scene 系列外，其余获准视觉参考
    // 都进入 prop 兼容粗类；STYLE_ONLY 的真实语义继续由 sourceType/role/tags 保留。
    case "style": return "prop";
    default: throw new Error(`不支持的允许参考资产 type：${sourceType}`);
  }
}

function assertSourceTypeRole(sourceType: string, role: string, assetId: string): void {
  const allowedByType: Record<string, readonly string[]> = {
    character: ["CHARACTER_IDENTITY"],
    scene: ["SCENE_TOPOLOGY"],
    scene_detail: ["SCENE_DETAIL"],
    scene_rule: ["SCENE_TOPOLOGY"],
    prop: ["PROP_IDENTITY"],
    key_non_character_element: ["PROP_IDENTITY"],
    style: ["STYLE_ONLY"],
  };
  const allowed = allowedByType[sourceType];
  if (!allowed || !allowed.includes(role)) {
    throw new Error(`允许参考资产 ${assetId} 的 type/reference_role 组合无效：${sourceType}/${role}`);
  }
}

function displayName(assetId: string): string {
  if (assetId.startsWith("char-dudu")) return "嘟嘟";
  if (assetId.startsWith("char-shuo")) return "朔";
  if (assetId.startsWith("char-su")) return "素";
  if (assetId === "prop-kaoyu-v1") return "烤鱼";
  if (assetId === "prop-yuanshizi-v1") return "圆石子";
  if (assetId === "element-xibian-butterfly-v1") return "溪边蝴蝶";
  if (assetId === "element-shixue-old-seal-v1") return "洞口旧封纹";
  return assetId;
}

function uploadableRegistryAssets(payload: RegistryPayload, productionRoot: string): DuduReferenceAsset[] {
  if (payload.max_referenced_image_paths_per_call !== 5) throw new Error("《嘟嘟》参考图上限必须为 5。 ");
  if (!Array.isArray(payload.assets)) throw new Error("允许参考资产 registry 缺少 assets 数组。 ");
  const allowedRoles = new Set(["CHARACTER_IDENTITY", "SCENE_TOPOLOGY", "PROP_IDENTITY", "SCENE_DETAIL", "STYLE_ONLY"]);
  const assets = (payload.assets as RegistryAssetRow[]).flatMap((row): DuduReferenceAsset[] => {
    const status = requiredText(row.status, "asset.status");
    const role = requiredText(row.reference_role, "asset.reference_role");
    const relativePath = requiredText(row.file, "asset.file");
    if ((status !== "APPROVED" && status !== "APPROVED_WITH_P2") || !allowedRoles.has(role)
      || !/\.(?:png|jpe?g|webp)$/iu.test(relativePath)) return [];
    const id = requiredText(row.id, "asset.id");
    const sourceType = requiredText(row.type, "asset.type");
    assertSourceTypeRole(sourceType, role, id);
    const name = displayName(id);
    return [{
      id,
      name,
      category: duduStudioCategoryForSourceType(sourceType),
      sourceType,
      referenceRole: role,
      relativePath,
      absolutePath: productionPath(productionRoot, relativePath),
      sha256: requiredSha(row.sha256, `${id}.sha256`),
      status,
      inherit: typeof row.inherit === "string" ? row.inherit.trim() : "严格继承当前批准参考图。",
      forbid: typeof row.forbid === "string" ? row.forbid.trim() : "禁止偏离当前批准参考图。",
      aliases: [...new Set([id, name, path.basename(relativePath), path.basename(relativePath, path.extname(relativePath))])],
    }];
  });
  const duplicate = assets.find((asset, index) => assets.findIndex((other) => other.id === asset.id) !== index);
  if (duplicate) throw new Error(`允许参考资产 ID 重复：${duplicate.id}`);
  return assets;
}

function secondLevelSections(body: string): Array<{ heading: string; body: string }> {
  const headings = [...body.matchAll(/^##\s+(.+)$/gmu)];
  return headings.map((match, index) => ({
    heading: match[1]!.trim(),
    body: body.slice(match.index!, headings[index + 1]?.index ?? body.length),
  }));
}

function matchingAssets(text: string, assets: DuduReferenceAsset[]): DuduReferenceAsset[] {
  return assets.filter((asset) => text.includes(asset.relativePath) || text.includes(path.basename(asset.relativePath)));
}

function parseV2BindingReferences(bindingBody: string, assets: DuduReferenceAsset[], unitId: string): DuduReferenceAsset[] {
  const sections = secondLevelSections(bindingBody).filter((section) => /^B\./u.test(section.heading) && /资产|参考/u.test(section.heading));
  if (sections.length !== 1) throw new Error(`${unitId} v2 BindingSet 必须有且只有一个 B. 资产门禁段，实际 ${sections.length}。`);
  const selected = new Map<string, DuduReferenceAsset>();
  for (const line of sections[0]!.body.split(/\r?\n/u)) {
    if (!/^\s*\|/u.test(line) || /^\s*\|\s*(?:---|:?-)/u.test(line)) continue;
    const referenced = matchingAssets(line, assets);
    if (/\.(?:png|jpe?g|webp)\b/iu.test(line) && referenced.length === 0) {
      throw new Error(`${unitId} v2 资产表含 registry 外图片：${line.trim()}`);
    }
    if (referenced.length === 0) continue;
    if (referenced.length !== 1) throw new Error(`${unitId} v2 资产表单行匹配多个 registry 资产。`);
    const asset = referenced[0]!;
    if (!line.includes(asset.id) || !line.includes(asset.relativePath) || !line.toLowerCase().includes(asset.sha256)
      || !line.includes(asset.referenceRole)) {
      throw new Error(`${unitId} v2 资产表 ${asset.id} 未逐字段锁定 id/role/path/SHA。`);
    }
    if (selected.has(asset.id)) throw new Error(`${unitId} v2 资产表重复资产：${asset.id}`);
    selected.set(asset.id, asset);
  }
  return [...selected.values()];
}

function v2SectionContent(bindingBody: string, prefix: string, unitId: string): string {
  const sections = secondLevelSections(bindingBody).filter((section) => section.heading.startsWith(prefix));
  if (sections.length !== 1) {
    throw new Error(`${unitId} v2 BindingSet 必须有且只有一个 ${prefix} 段，实际 ${sections.length}。`);
  }
  return sections[0]!.body.split(/\r?\n/u).slice(1).join("\n").trim();
}

function parseV2RawGridPrompt(bindingBody: string, unitId: string): string {
  const content = v2SectionContent(bindingBody, "E.", unitId);
  const fenced = /^```(?:text)?\s*\n([\s\S]*?)\n```\s*$/iu.exec(content);
  if (/```/u.test(content) && !fenced) {
    throw new Error(`${unitId} v2 E. raw 宫格提示词 fence 不闭合或混入 fence 外内容。`);
  }
  const prompt = (fenced?.[1] ?? content).trim();
  if (!prompt) throw new Error(`${unitId} v2 E. raw 宫格提示词为空。`);
  assertDuduPromptTextPathFree(prompt, `${unitId} v2 E. raw 宫格提示词`);
  return prompt;
}

function regexEscape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

const DUDU_SINGLE_CHARACTER_NON_ENTITY_COMPOUNDS: Readonly<Record<string, readonly string[]>> = {
  朔: ["扑朔", "朔风", "朔日", "朔月", "朔望"],
  父: ["祖父", "外祖父", "父级", "父类", "父节点", "父元素", "父目录"],
  素: ["朴素", "素色", "色素", "元素", "像素", "因素", "素描", "素材", "素质", "素养", "素人"],
  母: ["母版", "母图", "母带", "字母", "母题", "母线", "母体", "母语", "母本"],
  鱼: ["鱼眼", "鱼骨图", "鱼尾纹"],
};

function occurrenceCoveredByCompound(text: string, start: number, end: number, compounds: readonly string[]): boolean {
  return compounds.some((compound) => {
    let cursor = text.indexOf(compound);
    while (cursor >= 0) {
      const compoundEnd = cursor + compound.length;
      if (start >= cursor && end <= compoundEnd) return true;
      cursor = text.indexOf(compound, cursor + 1);
    }
    return false;
  });
}

/** 所有 prompt/Binding 语义消费者共用的 UTF-16 span 查找；单字角色词拒绝已知非实体复合词。 */
export function duduFindSemanticTokenRange(text: string, token: string): { start: number; end: number } | null {
  if (!token) return null;
  let cursor = text.indexOf(token);
  const compounds = token.length === 1 ? DUDU_SINGLE_CHARACTER_NON_ENTITY_COMPOUNDS[token] ?? [] : [];
  while (cursor >= 0) {
    const end = cursor + token.length;
    if (!occurrenceCoveredByCompound(text, cursor, end, compounds)) return { start: cursor, end };
    cursor = text.indexOf(token, cursor + 1);
  }
  return null;
}

export function duduTextIncludesSemanticToken(text: string, token: string): boolean {
  return duduFindSemanticTokenRange(text, token) !== null;
}

function textClauses(text: string): string[] {
  return text.split(/[。；\n]/u).map((clause) => clause.trim()).filter(Boolean);
}

const DUDU_PROMPT_PATH_PATTERNS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: "file URL", pattern: /(?:^|[\s（(：:'"`])file:\/\/\S+/iu },
  { label: "HTTP URL", pattern: /(?:^|[\s（(：:'"`])https?:\/\/\S+/iu },
  { label: "本机绝对路径", pattern: /(?:^|[\s（(：:'"`])\/(?:Users|private|tmp|Volumes|Applications|home|var|opt|etc)(?:\/|\\)\S*/u },
  { label: "Windows 绝对路径", pattern: /(?:^|[\s（(：:'"`])[A-Za-z]:[\\/]\S+/u },
  {
    label: "相对媒体路径",
    pattern: /(?:^|[\s（(：:'"`])(?:\.{0,2}[\\/])?(?:[^\s'"`()：]+[\\/])+[^\s'"`()：]+\.(?:png|jpe?g|webp|gif|bmp|tiff?|svg|mp4|mov|webm)(?=$|[\s'"`),，。；;])/iu,
  },
];

/** 视觉 prompt 最终边界：外部来源文本不得把本机/URL/相对媒体路径带入模型 payload。 */
export function assertDuduPromptTextPathFree(text: string, label: string): void {
  const matched = DUDU_PROMPT_PATH_PATTERNS.find((entry) => entry.pattern.test(text));
  if (matched) throw new Error(`${label} 含 ${matched.label}，禁止进入视觉提示词。`);
}

function uniqueCharacterClauseNamesAllowed(clause: string, allowed: DuduReferenceAsset[]): boolean {
  if (!/(?:唯一角色|角色(?:只有|仅有)|角色身份(?:只可|只能)|(?:只|仅)出现[^，,]{0,18}(?:角色|一名))/u.test(clause)) {
    return false;
  }
  return allowed.some((asset) => asset.category === "character"
    && duduReferenceSemanticTokens(asset).some((token) => duduTextIncludesSemanticToken(clause, token)));
}

function explicitForbiddenStrength(clause: string, asset: DuduReferenceAsset): "hard" | "partial" | null {
  for (const token of duduReferenceSemanticTokens(asset)) {
    if (!duduTextIncludesSemanticToken(clause, token)) continue;
    const escaped = regexEscape(token);
    if (new RegExp(`(?:无|没有|禁止|严禁|不得|不可|不应|不让)[^。；\\n]{0,18}${escaped}[^。；\\n]{0,10}(?:完整入画|完整角色|完整身体)`, "u").test(clause)
      || new RegExp(`${escaped}[^。；\\n]{0,10}(?:不得|不可|不应)?完整(?:入画|角色|身体)`, "u").test(clause)) {
      return "partial";
    }
    if (new RegExp(`(?:无|没有|禁止|严禁|不得|不可|不应|不让)[^。；\\n]{0,18}${escaped}`, "u").test(clause)
      || new RegExp(`${escaped}[^。；\\n]{0,18}(?:全程)?(?:画外|不入画|不得入画|不可见|不出现|不露出)`, "u").test(clause)) {
      return "hard";
    }
  }
  return null;
}

function v2PanelRuleBlocks(bindingBody: string, unitId: string): Array<{ panelIndex: number; body: string }> {
  const section = v2SectionContent(bindingBody, "D.", unitId);
  const headings = [...section.matchAll(new RegExp(`^###\\s+${regexEscape(unitId)}-G(\\d+)\\b.*$`, "gmu"))];
  return headings.map((match, index) => ({
    panelIndex: Number(match[1]),
    body: section.slice(match.index!, headings[index + 1]?.index ?? section.length),
  }));
}

function v2ForbiddenReferences(
  bindingBody: string,
  rawGridPrompt: string,
  allowed: DuduReferenceAsset[],
  assets: DuduReferenceAsset[],
  unitId: string,
  panelCount: number,
): DuduForbiddenReference[] {
  const allowedIds = new Set(allowed.map((asset) => asset.id));
  const candidates = assets.filter((asset) => asset.category === "character" && !allowedIds.has(asset.id));
  const unitSources = [
    { section: "A" as const, text: v2SectionContent(bindingBody, "A.", unitId) },
    { section: "E" as const, text: rawGridPrompt },
  ];
  const panelRules = v2PanelRuleBlocks(bindingBody, unitId);
  const allPanels = Array.from({ length: panelCount }, (_, index) => index + 1);
  const output: DuduForbiddenReference[] = [];
  for (const asset of candidates) {
    const evidence: DuduForbiddenReference["evidence"] = [];
    const scopedPanels = new Set<number>();
    let hasHardUnitEvidence = false;
    let hasPartialUnitEvidence = false;
    for (const source of unitSources) {
      for (const clause of textClauses(source.text)) {
        const unique = uniqueCharacterClauseNamesAllowed(clause, allowed);
        const strength = explicitForbiddenStrength(clause, asset);
        if (!unique && !strength) continue;
        evidence.push({ section: source.section, text: clause });
        if (unique || strength === "hard") hasHardUnitEvidence = true;
        if (strength === "partial") hasPartialUnitEvidence = true;
      }
    }
    if (hasHardUnitEvidence) allPanels.forEach((index) => scopedPanels.add(index));
    for (const block of panelRules) {
      for (const clause of textClauses(block.body)) {
        const strength = explicitForbiddenStrength(clause, asset);
        if (!strength) continue;
        if (strength === "partial" && !hasHardUnitEvidence) {
          throw new Error(`${unitId}-G${block.panelIndex} 对 ${asset.id} 只有“不得完整入画”部分可见约束，无法安全收敛为二态 forbidden。`);
        }
        evidence.push({ section: "D", panelIndex: block.panelIndex, text: clause });
        if (strength === "hard") scopedPanels.add(block.panelIndex);
      }
    }
    if (hasPartialUnitEvidence && !hasHardUnitEvidence && scopedPanels.size === 0) {
      throw new Error(`${unitId} 对 ${asset.id} 只有“不得完整入画”部分可见约束，缺少唯一角色/画外/不可见硬边界。`);
    }
    if (scopedPanels.size > 0) {
      output.push({ asset, panelIndexes: [...scopedPanels].sort((left, right) => left - right), evidence });
    }
  }
  return output;
}

function assertV2VisibleEntityClosure(input: {
  unitId: string;
  panels: DuduParsedPanel[];
  allowed: DuduReferenceAsset[];
  forbidden: DuduForbiddenReference[];
  registryAssets: DuduReferenceAsset[];
}): void {
  const forbiddenById = new Map(input.forbidden.map((entry) => [entry.asset.id, entry]));
  const classified = new Set([...input.allowed.map((asset) => asset.id), ...forbiddenById.keys()]);
  const visibleFieldNames = ["景别", "机位", "构图", "动作", "表情", "表情细节", "光线", "色彩"];
  for (const panel of input.panels) {
    const text = visibleFieldNames.map((name) => panel.fields[name] ?? "").join("\n");
    for (const entry of input.forbidden.filter((candidate) => candidate.panelIndexes.includes(panel.index))) {
      const clauses = textClauses(text).filter((clause) => duduReferenceSemanticTokens(entry.asset)
        .some((token) => duduTextIncludesSemanticToken(clause, token)));
      if (clauses.some((clause) => /(?:入画|出现在|居画|画面中|画左|画右|全身|身体|面部|特写|侧卧|走入|蹲坐|站立)/u.test(clause)
        && !/(?:画外|不入画|不可见|目光|看向|望向|方向)/u.test(clause))) {
        throw new Error(`${input.unitId}-G${panel.index} 的 ${entry.asset.id} 同时被声明可见与 forbidden。`);
      }
    }
    const unclassified = input.registryAssets.filter((asset) =>
      (asset.category === "character" || asset.category === "prop")
      && !classified.has(asset.id)
      && duduReferenceSemanticTokens(asset).some((token) => duduTextIncludesSemanticToken(text, token)));
    if (unclassified.length > 0) {
      throw new Error(`${input.unitId}-G${panel.index} 出现未由 B. 正向绑定或 A/E 显式禁止的已知实体：${unclassified.map((asset) => asset.id).join(",")}`);
    }
  }
}

/** 纯函数安全诊断：不读写文件，只解析 v2 A/D/E 的 raw 与角色禁出闭包。 */
export function auditDuduV2BindingSafetyClosure(input: {
  bindingBody: string;
  unitId: string;
  panelCount: number;
  panels: DuduParsedPanel[];
  allowed: DuduReferenceAsset[];
  registryAssets: DuduReferenceAsset[];
}): { rawGridPrompt: string; forbiddenReferences: DuduForbiddenReference[] } {
  const rawGridPrompt = parseV2RawGridPrompt(input.bindingBody, input.unitId);
  const parsedForbidden = v2ForbiddenReferences(
    input.bindingBody,
    rawGridPrompt,
    input.allowed,
    input.registryAssets,
    input.unitId,
    input.panelCount,
  );
  const forbiddenReferences = parsedForbidden.map((entry) => ({
    ...entry,
    panelIndexes: entry.panelIndexes.filter((panelIndex) => {
      const panel = input.panels[panelIndex - 1];
      return panel && (duduReferenceSemanticTokens(entry.asset)
        .some((token) => duduTextIncludesSemanticToken(panel.sourceText, token))
        || duduForbiddenRelationAnchorRanges(panel.sourceText, entry.asset).length > 0);
    }),
  })).filter((entry) => entry.panelIndexes.length > 0);
  assertV2VisibleEntityClosure({
    unitId: input.unitId,
    panels: input.panels,
    allowed: input.allowed,
    forbidden: forbiddenReferences,
    registryAssets: input.registryAssets,
  });
  return { rawGridPrompt, forbiddenReferences };
}

function parseLegacyGenerationReferences(generationBody: string, assets: DuduReferenceAsset[], unitId: string): DuduReferenceAsset[] {
  const lines = generationBody.split(/\r?\n/u);
  let context = "";
  const selected = new Map<string, DuduReferenceAsset>();
  for (const line of lines) {
    const heading = /^#{1,6}\s+(.+)$/u.exec(line);
    if (heading) context = heading[1]!.trim();
    if (/允许参考实际使用|实际参考|本次允许参考|参考图|输入与/u.test(line)) context = line.trim();
    const referenced = matchingAssets(line, assets);
    for (const asset of referenced) {
      if (!/参考|输入|允许|使用/u.test(`${context}\n${line}`)) {
        throw new Error(`${unitId} 历史生成记录中的 ${asset.id} 不在明确输入/参考语境。`);
      }
      selected.set(asset.id, asset);
    }
  }
  if (selected.size === 0) throw new Error(`${unitId} 历史生成记录未解析到任何明确图片参考。`);
  return [...selected.values()];
}

function referencesForBinding(
  format: "legacy" | "v2",
  bindingBody: string,
  generationBody: string,
  assets: DuduReferenceAsset[],
  unitId: string,
): DuduReferenceAsset[] {
  return format === "v2"
    ? parseV2BindingReferences(bindingBody, assets, unitId)
    : parseLegacyGenerationReferences(generationBody, assets, unitId);
}

function bindingLifecycle(format: "legacy" | "v2", body: string, unitId: string, historicalOnly: boolean): {
  lifecycle: "FROZEN_READY" | "HISTORICAL_PASS_ONLY";
  version: string;
  attemptBudget: number | null;
} {
  if (format === "legacy") return { lifecycle: "HISTORICAL_PASS_ONLY", version: "legacy", attemptBudget: null };
  const head = body.split(/\r?\n/u).slice(0, 12).join("\n");
  const version = /版本[：:]\s*`?(v[0-9.]+)/u.exec(head)?.[1] ?? "v2";
  if (historicalOnly) {
    if (!/FROZEN|RAW_PASS|PACKAGE_ANCHOR_READY/u.test(head)) throw new Error(`${unitId} 历史 v2 BindingSet 缺少冻结/PASS 状态。`);
    return { lifecycle: "HISTORICAL_PASS_ONLY", version, attemptBudget: null };
  }
  if (!/FROZEN\s*\/\s*READY_TO_DISPATCH/u.test(head)) throw new Error(`${unitId} v2 BindingSet 未处于 FROZEN / READY_TO_DISPATCH。`);
  const attemptBudget = /禁止\s*A3|A2\s*后/u.test(body) ? 2 : /A1/u.test(body) ? 1 : null;
  return { lifecycle: "FROZEN_READY", version, attemptBudget };
}

function evidenceObject(row: MachineUnitRow): Record<string, unknown> {
  if (!row.evidence || typeof row.evidence !== "object" || Array.isArray(row.evidence)) return {};
  return row.evidence as Record<string, unknown>;
}

async function readAndValidateVideoManifest(input: {
  productionRoot: string;
  unitId: string;
  panelCount: number;
  videoPackRelativePath: string;
  expectedRawRelativePath: string;
  expectedRawSha256: string;
}): Promise<{
  manifest: DuduSourceFileIdentity;
  packageFiles: DuduSourceFileIdentity[];
  labeled: DuduSourceFileIdentity;
  status: string;
  i2vReadiness: string;
}> {
  const manifestRelativePath = `${input.videoPackRelativePath}/manifest.json`;
  const manifestRead = await readStableFile(
    productionPath(input.productionRoot, manifestRelativePath),
    "production-root",
    manifestRelativePath,
  );
  const manifest = parseJsonObject(manifestRead.bytes, `${input.unitId}.manifest`) as VideoManifestPayload;
  if (manifest.manifest_version !== "2.0" || manifest.builder !== "tools/build_video_submission_pack.py"
    || manifest.unit_id !== input.unitId || (manifest.status !== "PASS" && manifest.status !== "LEGACY_PASS")) {
    throw new Error(`${input.unitId} video manifest 版本/构建器/单元/状态无效。`);
  }
  const rawPath = requiredText(manifest.raw?.path, `${input.unitId}.manifest.raw.path`);
  const rawSha = requiredSha(manifest.raw?.sha256, `${input.unitId}.manifest.raw.sha256`);
  if (rawPath !== input.expectedRawRelativePath || rawSha !== input.expectedRawSha256) {
    throw new Error(`${input.unitId} manifest raw 与机器 approved raw 不一致。`);
  }
  const sourceSpecPath = requiredText(manifest.source_spec?.path, `${input.unitId}.manifest.source_spec.path`);
  const sourceSpecSha = requiredSha(manifest.source_spec?.sha256, `${input.unitId}.manifest.source_spec.sha256`);
  const sourceSpecRead = await readStableFile(
    productionPath(input.productionRoot, sourceSpecPath),
    "production-root",
    sourceSpecPath,
    sourceSpecSha,
  );
  if (!Array.isArray(manifest.files)) throw new Error(`${input.unitId} manifest.files 必须是数组。`);
  const rows = manifest.files as VideoManifestFileRow[];
  const seen = new Set<string>();
  const packageFiles: DuduSourceFileIdentity[] = [sourceSpecRead.identity];
  let labeled: DuduSourceFileIdentity | undefined;
  for (const [index, row] of rows.entries()) {
    const relativeWithinPack = requiredText(row.path, `${input.unitId}.manifest.files[${index}].path`);
    if (path.basename(relativeWithinPack) !== relativeWithinPack || relativeWithinPack === "." || relativeWithinPack === "..") {
      throw new Error(`${input.unitId} manifest 文件必须是包目录内单层文件名：${relativeWithinPack}`);
    }
    if (seen.has(relativeWithinPack)) throw new Error(`${input.unitId} manifest 重复文件：${relativeWithinPack}`);
    seen.add(relativeWithinPack);
    const expectedSha = requiredSha(row.sha256, `${input.unitId}.manifest.files[${index}].sha256`);
    const projectRelativePath = `${input.videoPackRelativePath}/${relativeWithinPack}`;
    const read = await readStableFile(
      productionPath(input.productionRoot, projectRelativePath),
      "production-root",
      projectRelativePath,
      expectedSha,
    );
    packageFiles.push(read.identity);
    if (relativeWithinPack === `${input.unitId}_labeled.png`) labeled = read.identity;
  }
  const requiredFiles = [
    ...Array.from({ length: input.panelCount }, (_, index) => `${input.unitId}-G${index + 1}_raw.png`),
    ...Array.from({ length: input.panelCount }, (_, index) => `${input.unitId}-G${index + 1}_labeled.png`),
    ...Array.from({ length: input.panelCount }, (_, index) => `${input.unitId}-G${index + 1}_video.md`),
    `${input.unitId}_labeled.png`,
    `${input.unitId}_video.json`,
  ];
  const missing = requiredFiles.filter((file) => !seen.has(file));
  if (missing.length > 0 || !labeled) throw new Error(`${input.unitId} manifest 缺少必需包文件：${missing.join(",")}`);
  return {
    manifest: manifestRead.identity,
    packageFiles,
    labeled,
    status: requiredText(manifest.status, `${input.unitId}.manifest.status`),
    i2vReadiness: requiredText(manifest.i2v_readiness, `${input.unitId}.manifest.i2v_readiness`),
  };
}

function manifestFingerprint(files: DuduSourceFileIdentity[]): string {
  return digest(files.map((file) => ({
    scope: file.scope,
    relativePath: file.relativePath,
    sha256: file.sha256,
    sizeBytes: file.sizeBytes,
  })).sort((left, right) => `${left.scope}:${left.relativePath}`.localeCompare(`${right.scope}:${right.relativePath}`, "en")));
}

function assertSupportedContract(body: string): void {
  const requiredClauses: Array<[RegExp, string]> = [
    [/状态[：:]\s*ACTIVE/u, "ACTIVE 状态"],
    [/U00[—-]U32共33个单元/u, "S1E1 U00—U32 共33单元"],
    [/U00是12秒序章[；;]U01[—-]U32各15秒/u, "U00=12秒且U01—U32=15秒"],
    [/每次生图实际参考图1[—-]5张/u, "实际参考图1—5张"],
    [/完成后停止[，,]不进入S1E2/u, "完成后停止且不进入S1E2"],
    [/流星纹只允许作为默认OFF的镜头级VFX/u, "流星纹默认OFF且仅镜头级VFX"],
  ];
  for (const [pattern, label] of requiredClauses) {
    if (!pattern.test(body)) throw new Error(`唯一长期合同缺少或改变不受支持的范围条款：${label}`);
  }
}

export async function inspectDuduReadonlySources(input: DuduReadonlySourceInput): Promise<DuduReadonlySourceInspection> {
  const productionRoot = await assertCanonicalDirectory(input.productionRoot, "productionRoot");
  const lockedScriptPath = path.resolve(input.lockedScriptPath);
  const contractRelativePath = input.contractRelativePath ?? "00_唯一长期执行合同_v2.md";
  const machineStateRelativePath = input.machineStateRelativePath ?? "02_出图总表/00_S1E1_生产状态.json";
  const referenceRegistryRelativePath = input.referenceRegistryRelativePath ?? "01_视觉资产锁/00_允许参考资产.json";
  const visualCanonRevisionRelativePath = input.visualCanonRevisionRelativePath ?? "00_视觉正典_v2/00_视觉正典修订说明.md";
  const visualExecutionRelativePath = input.visualExecutionRelativePath ?? DUDU_VISUAL_EXECUTION_RELATIVE_PATH;
  const visualConflictDecisionRelativePath = input.visualConflictDecisionRelativePath ?? "01_视觉资产锁/00_正典冲突与执行裁决.md";
  const meteorVfxRuleRelativePath = input.meteorVfxRuleRelativePath ?? "01_视觉资产锁/04_特殊规则/rule-liuxingdeng-v2_故事卡.md";
  const videoBuilderRelativePath = "tools/build_video_submission_pack.py";

  const [scriptRead, contractRead, machineRead, registryRead, visualCanonRead, visualExecutionRead, conflictDecisionRead, meteorRuleRead, videoBuilderRead] = await Promise.all([
    readStableFile(lockedScriptPath, "locked-source", path.basename(lockedScriptPath)),
    readStableFile(productionPath(productionRoot, contractRelativePath), "production-root", contractRelativePath),
    readStableFile(productionPath(productionRoot, machineStateRelativePath), "production-root", machineStateRelativePath),
    readStableFile(productionPath(productionRoot, referenceRegistryRelativePath), "production-root", referenceRegistryRelativePath),
    readStableFile(productionPath(productionRoot, visualCanonRevisionRelativePath), "production-root", visualCanonRevisionRelativePath),
    readStableFile(productionPath(productionRoot, visualExecutionRelativePath), "production-root", visualExecutionRelativePath),
    readStableFile(productionPath(productionRoot, visualConflictDecisionRelativePath), "production-root", visualConflictDecisionRelativePath),
    readStableFile(productionPath(productionRoot, meteorVfxRuleRelativePath), "production-root", meteorVfxRuleRelativePath),
    readStableFile(productionPath(productionRoot, videoBuilderRelativePath), "production-root", videoBuilderRelativePath),
  ]);
  const scriptBody = scriptRead.bytes.toString("utf8");
  const contractBody = contractRead.bytes.toString("utf8");
  const visualCanonBody = visualCanonRead.bytes.toString("utf8");
  const visualExecutionBody = visualExecutionRead.bytes.toString("utf8");
  const conflictDecisionBody = conflictDecisionRead.bytes.toString("utf8");
  const meteorRuleBody = meteorRuleRead.bytes.toString("utf8");
  assertSupportedContract(contractBody);
  if (!/DEC-METEOR-VFX-003/u.test(`${visualCanonBody}\n${visualExecutionBody}\n${conflictDecisionBody}\n${meteorRuleBody}`)
    || !/meteor_vfx(?:_state)?=`?OFF|meteor_vfx=OFF/u.test(visualExecutionBody)
    || !/SHOT_LEVEL_VFX|镜头级\s*VFX/u.test(meteorRuleBody)) {
    throw new Error("视觉正典 v2.1 / DEC-METEOR-VFX-003 / 镜头级VFX默认OFF 的上位裁决闭包无效。 ");
  }
  const machine = parseJsonObject(machineRead.bytes, "机器状态") as MachinePayload;
  const registry = parseJsonObject(registryRead.bytes, "允许参考资产") as RegistryPayload;
  const parsedUnits = parseScriptUnits(scriptBody);
  const visualExecutionUnits = parseScriptUnits(visualExecutionBody);
  for (const [index, unit] of parsedUnits.entries()) {
    const visual = visualExecutionUnits[index];
    if (!visual || visual.unitId !== unit.unitId || visual.durationSeconds !== unit.durationSeconds
      || visual.panelCount !== unit.panelCount || visual.panels.some((panel, panelIndex) => {
        const locked = unit.panels[panelIndex];
        return !locked || panel.id !== locked.id || panel.durationSeconds !== locked.durationSeconds
          || panel.startSeconds !== locked.startSeconds || panel.endSeconds !== locked.endSeconds;
      })) {
      throw new Error(`${unit.unitId} 的 visual-execution-v2.1 与锁版剧情时码/格序不一致。`);
    }
  }
  const machineRows = Array.isArray(machine.units) ? machine.units as MachineUnitRow[] : [];
  if (machineRows.length !== 33) throw new Error(`机器状态单元数应为 33，实际 ${machineRows.length}。`);
  const machineByUnit = new Map(machineRows.map((row) => [requiredText(row.unit_id, "machine.unit_id"), row]));
  if (machineByUnit.size !== 33) throw new Error("机器状态包含重复单元。 ");
  const uploadableAssets = uploadableRegistryAssets(registry, productionRoot);
  const fileMap = new Map<string, DuduSourceFileIdentity>();
  const addFile = (file: DuduSourceFileIdentity) => {
    const key = `${file.scope}:${file.relativePath}`;
    const existing = fileMap.get(key);
    if (existing && (existing.sha256 !== file.sha256 || existing.sizeBytes !== file.sizeBytes)) {
      throw new Error(`source manifest 同路径身份冲突：${key}`);
    }
    fileMap.set(key, file);
  };
  [
    scriptRead.identity,
    contractRead.identity,
    machineRead.identity,
    registryRead.identity,
    visualCanonRead.identity,
    visualExecutionRead.identity,
    conflictDecisionRead.identity,
    meteorRuleRead.identity,
    videoBuilderRead.identity,
  ].forEach(addFile);

  const units: DuduReadonlyUnitSource[] = [];
  for (const parsed of parsedUnits) {
    const visualExecutionUnit = visualExecutionUnits[parsed.sequence - 1]!;
    const machineRow = machineByUnit.get(parsed.unitId);
    if (!machineRow) throw new Error(`机器状态缺少 ${parsed.unitId}。`);
    if (Number(machineRow.duration_sec) !== parsed.durationSeconds || Number(machineRow.panel_count) !== parsed.panelCount) {
      throw new Error(`${parsed.unitId} 的机器状态与锁版剧本时长/格数不一致。`);
    }
    const numeric = Number(parsed.unitId.slice(-2));
    const toolInvocationCount = requiredInteger(machineRow.tool_invocation_count, `${parsed.unitId}.tool_invocation_count`);
    const visualCandidateCount = requiredInteger(machineRow.visual_candidate_count, `${parsed.unitId}.visual_candidate_count`);
    const rejectedCandidates = Array.isArray(machineRow.rejected_candidates) ? machineRow.rejected_candidates : [];
    const historicalPassCandidate = numeric <= 27
      || ((numeric === 28 || numeric === 29)
        && (machineRow.storyboard_status === "PASS" || machineRow.storyboard_status === "PASS_WITH_P2")
        && (machineRow.raw_qc_status === "VISUAL_PASS" || machineRow.raw_qc_status === "VISUAL_PASS_WITH_P2"));
    const knownRejectedU30 = numeric === 30
      && machineRow.storyboard_status === "REJECTED"
      && machineRow.raw_qc_status === "VISUAL_REJECTED"
      && !machineRow.approved_raw_path
      && rejectedCandidates.length > 0
      && visualCandidateCount >= 1
      && toolInvocationCount >= visualCandidateCount;
    if (historicalPassCandidate) {
      if (visualCandidateCount < 1 || toolInvocationCount < visualCandidateCount) {
        throw new Error(`${parsed.unitId} 历史调用/候选计数无效：calls=${toolInvocationCount} candidates=${visualCandidateCount}`);
      }
    } else if (!knownRejectedU30 && (toolInvocationCount !== 0 || visualCandidateCount !== 0 || machineRow.approved_raw_path
      || rejectedCandidates.length > 0)) {
      throw new Error(`${parsed.unitId} 存在未纳入历史 PASS 的调用/候选/raw 活动，必须先对账后才能导入。`);
    }
    let binding: DuduReadonlyUnitSource["binding"] = null;
    let references: DuduReferenceAsset[] = [];
    let forbiddenReferences: DuduReadonlyUnitSource["forbiddenReferences"] = [];
    if (numeric <= 29) {
      const format = numeric >= 13 ? "v2" : "legacy";
      const bindingRelativePath = `05_提示词/${parsed.unitId}_BindingSet${format === "v2" ? "_v2" : ""}.md`;
      const bindingRead = await readStableFile(productionPath(productionRoot, bindingRelativePath), "production-root", bindingRelativePath);
      addFile(bindingRead.identity);
      let generationRecord: (DuduSourceFileIdentity & { body: string }) | undefined;
      if (format === "legacy") {
        const generationRelativePath = `05_提示词/${parsed.unitId}_生成记录.md`;
        const generationRead = await readStableFile(productionPath(productionRoot, generationRelativePath), "production-root", generationRelativePath);
        addFile(generationRead.identity);
        generationRecord = { ...generationRead.identity, body: generationRead.bytes.toString("utf8") };
      }
      const bindingBody = bindingRead.bytes.toString("utf8");
      references = referencesForBinding(format, bindingBody, generationRecord?.body ?? "", uploadableAssets, parsed.unitId);
      if (references.length < 1 || references.length > 5) {
        throw new Error(`${parsed.unitId} 当前 BindingSet 解析出 ${references.length} 张图片参考，必须为 1–5。`);
      }
      const safety = format === "v2" ? auditDuduV2BindingSafetyClosure({
        bindingBody,
        unitId: parsed.unitId,
        panelCount: parsed.panelCount,
        panels: visualExecutionUnit.panels,
        allowed: references,
        registryAssets: uploadableAssets,
      }) : undefined;
      const rawGridPrompt = safety?.rawGridPrompt;
      forbiddenReferences = safety?.forbiddenReferences ?? [];
      binding = {
        format,
        file: bindingRead.identity,
        body: bindingBody,
        ...(rawGridPrompt ? { rawGridPrompt } : {}),
        ...bindingLifecycle(format, bindingBody, parsed.unitId, historicalPassCandidate),
        ...(generationRecord ? { generationRecord } : {}),
      };
      for (const reference of [...references, ...forbiddenReferences.map((entry) => entry.asset)]) {
        const mediaRead = await readStableFile(reference.absolutePath, "production-root", reference.relativePath, reference.sha256);
        addFile(mediaRead.identity);
      }
    }

    let historicalPass: DuduHistoricalPassSource | null = null;
    if (historicalPassCandidate) {
      const storyboardStatus = machineRow.storyboard_status;
      const rawQcStatus = machineRow.raw_qc_status;
      if ((storyboardStatus !== "PASS" && storyboardStatus !== "PASS_WITH_P2")
        || (rawQcStatus !== "VISUAL_PASS" && rawQcStatus !== "VISUAL_PASS_WITH_P2")) {
        throw new Error(`${parsed.unitId} 不满足历史 PASS 导入门：storyboard=${String(machineRow.storyboard_status)} qc=${String(machineRow.raw_qc_status)}`);
      }
      const rawRelativePath = requiredText(machineRow.approved_raw_path, `${parsed.unitId}.approved_raw_path`);
      const rawExpectedSha = requiredSha(machineRow.approved_raw_sha256, `${parsed.unitId}.approved_raw_sha256`);
      const evidence = evidenceObject(machineRow);
      const qcRelativePath = requiredText(evidence.qc, `${parsed.unitId}.evidence.qc`);
      const videoPackRelativePath = requiredText(evidence.video_pack, `${parsed.unitId}.evidence.video_pack`);
      const [rawRead, qcRead, videoManifest] = await Promise.all([
        readStableFile(productionPath(productionRoot, rawRelativePath), "production-root", rawRelativePath, rawExpectedSha),
        readStableFile(productionPath(productionRoot, qcRelativePath), "production-root", qcRelativePath),
        readAndValidateVideoManifest({
          productionRoot,
          unitId: parsed.unitId,
          panelCount: parsed.panelCount,
          videoPackRelativePath,
          expectedRawRelativePath: rawRelativePath,
          expectedRawSha256: rawExpectedSha,
        }),
      ]);
      [rawRead.identity, qcRead.identity, videoManifest.manifest, ...videoManifest.packageFiles].forEach(addFile);
      const externalStoryboardStatus = storyboardStatus === "PASS_WITH_P2" || rawQcStatus === "VISUAL_PASS_WITH_P2"
        ? "PASS_WITH_P2"
        : "PASS";
      historicalPass = {
        raw: rawRead.identity,
        labeled: videoManifest.labeled,
        qc: qcRead.identity,
        manifest: videoManifest.manifest,
        packageFiles: videoManifest.packageFiles,
        videoPackStatus: String(machineRow.video_pack_status ?? "UNKNOWN"),
        i2vReadiness: videoManifest.i2vReadiness,
        externalStoryboardStatus,
      };
    }
    units.push({
      ...parsed,
      visualExecutionPanels: visualExecutionUnit.panels,
      machineState: machineRow,
      binding,
      forbiddenReferences,
      references,
      historicalPass,
    });
  }

  const totalDurationSeconds = units.reduce((total, unit) => total + unit.durationSeconds, 0);
  if (totalDurationSeconds !== 492 || units[0]?.durationSeconds !== 12 || units[0]?.panelCount !== 3
    || units[1]?.episodeStartSeconds !== 12 || units[32]?.episodeStartSeconds !== 477 || units[32]?.episodeEndSeconds !== 492) {
    throw new Error("S1E1 真实时长闭包无效：必须 U00=12s/3格、U01=12s 起、U32=477–492s、总计492s。 ");
  }
  const staleSummary = scriptBody.split(/\r?\n/u).find((line) => /U00（2\s*格\s*12s/u.test(line));
  if (!staleSummary) throw new Error("锁版剧本未找到已知 U00 2格/12s 残留摘要，禁止静默改变冲突裁决。 ");
  const historicalStoryboardPassUnitIds = units.filter((unit) => unit.historicalPass).map((unit) => unit.unitId);
  const bindingReadyUnitIds = units.filter((unit) => unit.binding?.lifecycle === "FROZEN_READY").map((unit) => unit.unitId);
  const missingBindingUnitIds = units.filter((unit) => !unit.binding).map((unit) => unit.unitId);
  const pendingStoryboardUnitIds = units.filter((unit) => !unit.historicalPass).map((unit) => unit.unitId);
  const computedProjection: DuduComputedProductionProjection = {
    historicalStoryboardPassUnitIds,
    bindingReadyUnitIds,
    missingBindingUnitIds,
    pendingStoryboardUnitIds,
    earliestStoryboardPending: pendingStoryboardUnitIds[0] ?? null,
    earliestBindingReadyPending: units.find((unit) => !unit.historicalPass && unit.binding?.lifecycle === "FROZEN_READY")?.unitId ?? null,
    earliestMissingBinding: units.find((unit) => !unit.binding)?.unitId ?? null,
  };
  const machineSummary = machine.summary && typeof machine.summary === "object" && !Array.isArray(machine.summary)
    ? machine.summary as Record<string, unknown>
    : {};
  if (machineSummary.unit_count !== 33 || machineSummary.storyboard_pass_count !== historicalStoryboardPassUnitIds.length
    || machineSummary.earliest_storyboard_pending !== computedProjection.earliestStoryboardPending) {
    throw new Error("机器 summary 与逐单元 approved raw/QC 文件事实不一致。 ");
  }
  const conflicts: DuduSourceConflictDiagnostic[] = [{
    code: "U00_STALE_TWO_GRID_SUMMARY",
    unitId: "S1E01-U00",
    resolution: "STRUCTURED_3_GRID_12_SECONDS",
    evidence: [
      "单元头：S1E01-U00 · 12s · 3宫格",
      "实际段落：S1E01-U00-G1/G2/G3",
      "机器状态：duration_sec=12,panel_count=3",
      `冲突残留：${staleSummary.trim()}`,
    ],
  }, {
    code: "LOCKED_VISUAL_TERMS_OVERRIDDEN_BY_V21",
    resolution: "LOCKED_PLOT_CAUSALITY_PLUS_VISUAL_EXECUTION_V21",
    evidence: [
      `唯一合同：${contractRead.identity.relativePath} / ${contractRead.identity.sha256}`,
      `视觉执行：${visualExecutionRead.identity.relativePath} / ${visualExecutionRead.identity.sha256}`,
      "冻结源旧视觉词只作剧情/时码/source-span证据；活动 prompt、costume、continuity 采用 DEC-METEOR-VFX-003。",
    ],
  }];
  for (const unit of units) {
    if (unit.historicalPass?.externalStoryboardStatus === "PASS_WITH_P2" && unit.machineState.storyboard_status === "PASS") {
      conflicts.push({
        code: "HISTORICAL_P2_PROJECTION_MERGED",
        unitId: unit.unitId,
        resolution: "PASS_WITH_P2",
        evidence: [
          `machine.storyboard_status=${String(unit.machineState.storyboard_status)}`,
          `machine.raw_qc_status=${String(unit.machineState.raw_qc_status)}`,
          `qc=${unit.historicalPass.qc.relativePath}/${unit.historicalPass.qc.sha256}`,
        ],
      });
    }
    if (!unit.historicalPass && unit.binding?.lifecycle === "FROZEN_READY"
      && !/READY|FROZEN/u.test(String(unit.machineState.preparation_status ?? ""))) {
      conflicts.push({
        code: "BINDING_MACHINE_PROJECTION_STALE",
        unitId: unit.unitId,
        resolution: "BINDING_FILE_IS_CURRENT_BUT_MACHINE_PROJECTION_REQUIRES_RECONCILIATION",
        evidence: [
          `binding=${unit.binding.file.relativePath}/${unit.binding.file.sha256}`,
          `preparation_status=${String(unit.machineState.preparation_status ?? "UNKNOWN")}`,
          `generation_status=${String(unit.machineState.generation_status ?? "UNKNOWN")}`,
        ],
      });
    }
  }
  const sourceFiles = [...fileMap.values()].sort((left, right) =>
    `${left.scope}:${left.relativePath}`.localeCompare(`${right.scope}:${right.relativePath}`, "en"));
  const sourceManifestFingerprint = manifestFingerprint(sourceFiles);
  const productionScopeFingerprint = createHash("sha256").update(JSON.stringify({
    contractSha256: contractRead.identity.sha256,
    season: "S1",
    episode: "S1E1",
    unitIds: FIXED_UNIT_IDS,
    unitCount: 33,
  }), "utf8").digest("hex");
  const referenceAssets = [...new Map(units.flatMap((unit) => [
    ...unit.references,
    ...unit.forbiddenReferences.map((entry) => entry.asset),
  ])
    .map((asset) => [asset.id, asset])).values()]
    .sort((left, right) => left.id.localeCompare(right.id, "en"));
  return {
    schemaVersion: 1,
    kind: "dudu-readonly-source-inspection",
    lockedScript: { ...scriptRead.identity, body: scriptBody },
    contract: { ...contractRead.identity, body: contractBody },
    visualCanonRevision: { ...visualCanonRead.identity, body: visualCanonBody },
    visualExecution: { ...visualExecutionRead.identity, body: visualExecutionBody },
    visualConflictDecision: { ...conflictDecisionRead.identity, body: conflictDecisionBody },
    meteorVfxRule: { ...meteorRuleRead.identity, body: meteorRuleBody },
    machineStateFile: machineRead.identity,
    referenceRegistryFile: registryRead.identity,
    lockedScriptPath,
    productionRoot,
    unitIds: [...FIXED_UNIT_IDS],
    units,
    referenceAssets,
    sourceFiles,
    sourceManifestFingerprint,
    productionScopeFingerprint,
    conflicts,
    computedProjection,
    summary: {
      unitCount: 33,
      totalDurationSeconds: 492,
      panelCount: units.reduce((total, unit) => total + unit.panelCount, 0),
      bindingCount: units.filter((unit) => unit.binding).length as 30,
      historicalPassCount: units.filter((unit) => unit.historicalPass).length as 28,
      approvedRawCount: units.filter((unit) => unit.historicalPass?.raw).length as 28,
      contractMinReferences: 1,
      contractMaxReferences: 5,
      actualMinReferences: Math.min(...units.filter((unit) => unit.binding).map((unit) => unit.references.length)),
      actualMaxReferences: Math.max(...units.filter((unit) => unit.binding).map((unit) => unit.references.length)),
    },
  };
}

const DUDU_REFERENCE_SEMANTIC_TOKENS: Record<string, string[]> = {
  "char-dudu-user-locked-v1": ["嘟嘟", "崽"],
  "char-shuo-user-locked-v1": ["朔", "父"],
  "char-su-user-locked-v1": ["素", "母"],
  "scene-night-sky-starfall-ne-v2": ["坠星", "星坠", "夜空", "天幕"],
  "scene-shixue-dawn-zhulong-horizon-v2": ["烛龙", "直目", "竖瞳", "晨昏"],
  "scene-shixue-root-detail-v1": ["树根", "雷痕", "草窝"],
  "prop-kaoyu-v1": ["烤鱼", "鱼"],
  "prop-yuanshizi-v1": ["圆石", "石子"],
  "element-xibian-butterfly-v1": ["蝴蝶"],
  "element-shixue-old-seal-v1": ["封纹", "旧封", "血线", "爪印"],
};

export function duduReferenceSemanticTokens(asset: DuduReferenceAsset): string[] {
  const legacyAssetId = asset.id
    .replace(/-user-locked-v\d+(?:\.\d+)?$/u, "")
    .replace(/-v\d+(?:\.\d+)?$/u, "");
  return [...new Set([
    asset.id,
    legacyAssetId,
    asset.name,
    ...asset.aliases,
    ...(DUDU_REFERENCE_SEMANTIC_TOKENS[asset.id] ?? []),
  ].map((value) => value.trim()).filter(Boolean))];
}

/** 锁版格中可解释的画外关系锚；只用于 forbidden mention，不把锚自身当可见资产。 */
export function duduForbiddenRelationAnchors(asset: DuduReferenceAsset): string[] {
  switch (asset.id) {
    case "char-dudu-user-locked-v1": return ["幼崽", "一家人", "崽的窝"];
    case "char-su-user-locked-v1": return ["母亲", "母兽", "双亲", "一家人", "母崽"];
    case "char-shuo-user-locked-v1": return ["父亲", "父兽", "双亲", "一家人"];
    default: return [];
  }
}

/**
 * 返回可落到锁版原文 UTF-16 span 的画外关系锚。通用“窝”本身不是人物证据；
 * 仅当同一格明确出现父/朔时，才把“窝”解释为嘟嘟所在的家庭窝关系。
 */
export function duduForbiddenRelationAnchorRanges(
  text: string,
  asset: DuduReferenceAsset,
): Array<{ text: string; start: number; end: number }> {
  const ranges = duduForbiddenRelationAnchors(asset).flatMap((token) => {
    const range = duduFindSemanticTokenRange(text, token);
    return range ? [{ text: token, ...range }] : [];
  });
  if (asset.id === "char-dudu-user-locked-v1"
    && ["父", "朔"].some((token) => duduTextIncludesSemanticToken(text, token))) {
    const nest = duduFindSemanticTokenRange(text, "窝");
    if (nest) ranges.push({ text: "窝", ...nest });
  }
  return [...new Map(ranges.map((entry) => [`${entry.start}:${entry.end}`, entry] as const)).values()];
}

export function duduReferencePresenceForPanel(
  panel: DuduParsedPanel,
  asset: DuduReferenceAsset,
): "required" | "optional" | "forbidden" {
  const visibleFieldNames = ["景别", "机位", "构图", "动作", "表情", "表情细节", "光线", "色彩"];
  const text = visibleFieldNames.map((name) => panel.fields[name] ?? "").join("\n");
  if (/纯黑|黑场/u.test(text) && !/母与崽|嘟嘟|朔|素|父|母/u.test(text)) return "forbidden";
  const tokens = duduReferenceSemanticTokens(asset);
  const explicitlyOffscreen = tokens.some((token) => {
    const range = duduFindSemanticTokenRange(text, token);
    return Boolean(range && /^(?:.{0,8})(?:画外|不入画|不可见)/u.test(text.slice(range.end)));
  });
  if (!explicitlyOffscreen && tokens.some((token) => duduTextIncludesSemanticToken(text, token))) return "required";
  if (asset.sourceType === "style") return "optional";
  if (asset.category === "character" || asset.category === "prop") return "forbidden";
  return "optional";
}
