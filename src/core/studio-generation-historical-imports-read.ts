/**
 * 历史 PASS 只读读取（T9 投影合并用）：
 * readStudioGenerationProjectionSelectionFacts()
 *
 * 单次只读快照连接取齐：
 * - 每单元最新一条 studio_generation_historical_imports 候选（含闭合核验）
 * - 指定 generation_run_id 的 pack_fingerprint（投影 selectedPackFingerprint 填充）
 *
 * 只读保证：经 openSqliteReadOnlySnapshot 在系统临时目录打开隔离副本，
 * 不触活库、不产生 WAL/SHM；表/库不存在一律返回空结果（老库防御）。
 *
 * 闭合核验口径（如实声明，不假验）：
 * - 历史记录自带 PASS：external_storyboard_status ∈ {PASS, PASS_WITH_P2}（导入端合同同口径）；
 * - 修订当前：import 行 unit_revision === 生产库当前 revision（旧修订历史不冒充当前 PASS）；
 * - frozen pack/packFingerprint 匹配：packs 表存在 (pack_id, fingerprint) 与 import 行一致的记录；
 * - SHA 一致：import 行 raw/labeled 与 source_*_sha256 相同（导入合同：保留源原字节），
 *   且 CAS 对象存在于按其 SHA 寻址的路径（内容寻址即寻址级 SHA 匹配；
 *   字节级复算属 T10 verifyApprovedTimelineMedia 职责，本模块不重算）；
 * - raw/labeled 可读：媒体 CAS 对象为普通文件且非空；
 * - 参考闭包完整：冻结包 JSON 可读，且 controlReferences[].mediaSha256 均命中媒体 CAS。
 */
import { existsSync } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { inspectManagedProjectReadOnly } from "./managed-project.js";
import { openSqliteReadOnlySnapshot } from "./sqlite-readonly-snapshot.js";

export const HISTORICAL_IMPORTS_READ_SCHEMA_VERSION = 1 as const;

/** 冻结包 JSON 读取上限：与账本 MAX_PACK_BYTES 合同一致（4 MiB）；超限视为闭包损坏，不猜。 */
const MAX_PACK_JSON_BYTES = 4 * 1024 * 1024;
/** IN (...) 分批（与账本批量函数同口径，避免变量数触顶）。 */
const BATCH_QUERY_CHUNK_SIZE = 500;
/** 合法 SHA-256（64 位小写十六进制）。 */
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/u;

/** 单个单元的已核验历史 PASS 候选。 */
export interface StudioHistoricalPassCandidate {
  unitId: string;
  importId: string;
  packId: string;
  packFingerprint: string;
  /** import 行登记的单元修订（核验时已与当前修订比较）。 */
  unitRevision: number;
  rawMediaSha256: string;
  labeledMediaSha256: string;
  externalStoryboardStatus: string;
  /** 逐条闭合核验失败原因（空数组 = 全部可实现项均通过）。 */
  verificationFailures: string[];
  /** 全部可实现的闭合条件均通过（verified=true 才可被投影选为历史 PASS）。 */
  verified: boolean;
}

export interface StudioGenerationProjectionSelectionFacts {
  /** 每单元最新一条历史导入候选（含核验结论）；无历史导入的单元不出现。 */
  historicalPassByUnit: Map<string, StudioHistoricalPassCandidate>;
  /** generation_run_id → pack_fingerprint（正式 run 的 selectedPackFingerprint 填充）。 */
  packFingerprintByRunId: Map<string, string>;
}

interface HistoricalImportJoinRow {
  unit_id: string;
  import_id: string;
  pack_id: string;
  pack_fingerprint: string;
  unit_revision: number;
  raw_media_sha256: string;
  labeled_media_sha256: string;
  source_raw_sha256: string;
  source_labeled_sha256: string;
  external_storyboard_status: string;
  pack_content_relpath: string | null;
}

function sqlPlaceholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}

/** 媒体 CAS 对象可读性：普通文件且非空（内容寻址路径本身即 SHA 寻址级匹配）。 */
async function casObjectReadable(mediaCasRoot: string, sha256: string): Promise<boolean> {
  if (!SHA256_HEX_PATTERN.test(sha256)) return false;
  try {
    const stat = await lstat(path.join(mediaCasRoot, sha256.slice(0, 2), sha256));
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

/**
 * 批量读取投影选择事实（历史 PASS 候选 + run pack fingerprint）。
 * 单单元失败隔离由投影层负责；本函数整体失败（账本损坏等）向外抛出，
 * 不静默退化为"无历史 PASS"的假相。
 */
export async function readStudioGenerationProjectionSelectionFacts(
  projectRoot: string,
  input: {
    /** 参与投影的单元及其当前修订（revision 用于历史候选的修订当前性核验）。 */
    units: Array<{ unitId: string; revision: number }>;
    /** 需要 pack_fingerprint 的 generation_run_id 列表（通常为正式 PASS run）。 */
    generationRunIds: string[];
  },
): Promise<StudioGenerationProjectionSelectionFacts> {
  const empty: StudioGenerationProjectionSelectionFacts = {
    historicalPassByUnit: new Map(),
    packFingerprintByRunId: new Map(),
  };
  if (input.units.length === 0 && input.generationRunIds.length === 0) return empty;

  const shell = await inspectManagedProjectReadOnly(projectRoot);
  const databasePath = shell.paths.generationDatabase;
  // 账本尚未创建（无冻结/派发历史的工程）：空事实，非错误。
  if (!existsSync(databasePath)) return empty;

  const snapshot = await openSqliteReadOnlySnapshot(databasePath, "generation ledger historical read");
  try {
    const db = snapshot.database;
    const tableExists = (name: string): boolean => Boolean(
      db.prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?").get(name),
    );
    const hasHistoricalImports = tableExists("studio_generation_historical_imports");
    const hasPacks = tableExists("studio_generation_packs");
    const hasDispatches = tableExists("studio_generation_dispatches");

    // 1. 每单元最新一条历史导入（LEFT JOIN packs 保留 fingerprint 不匹配的可观测性）。
    const latestImportByUnit = new Map<string, HistoricalImportJoinRow>();
    if (hasHistoricalImports && input.units.length > 0) {
      const unitIds = input.units.map((unit) => unit.unitId);
      for (let offset = 0; offset < unitIds.length; offset += BATCH_QUERY_CHUNK_SIZE) {
        const chunk = unitIds.slice(offset, offset + BATCH_QUERY_CHUNK_SIZE);
        const rows = db.prepare(`
          SELECT unit_id, import_id, pack_id, pack_fingerprint, unit_revision,
            raw_media_sha256, labeled_media_sha256, source_raw_sha256, source_labeled_sha256,
            external_storyboard_status, pack_content_relpath
          FROM (
            SELECT h.unit_id, h.import_id, h.pack_id, h.pack_fingerprint, h.unit_revision,
              h.raw_media_sha256, h.labeled_media_sha256, h.source_raw_sha256, h.source_labeled_sha256,
              h.external_storyboard_status,
              ${hasPacks ? "p.content_relpath" : "NULL"} AS pack_content_relpath,
              ROW_NUMBER() OVER (PARTITION BY h.unit_id ORDER BY h.sequence DESC) AS rn
            FROM studio_generation_historical_imports h
            ${hasPacks ? `LEFT JOIN studio_generation_packs p
              ON p.pack_id = h.pack_id AND p.fingerprint = h.pack_fingerprint` : ""}
            WHERE h.unit_id IN (${sqlPlaceholders(chunk.length)})
          ) WHERE rn = 1
        `).all(...chunk) as unknown as HistoricalImportJoinRow[];
        for (const row of rows) latestImportByUnit.set(row.unit_id, row);
      }
    }

    // 2. 指定 run 的 pack_fingerprint。
    const packFingerprintByRunId = new Map<string, string>();
    if (hasDispatches && input.generationRunIds.length > 0) {
      const runIds = [...new Set(input.generationRunIds)];
      for (let offset = 0; offset < runIds.length; offset += BATCH_QUERY_CHUNK_SIZE) {
        const chunk = runIds.slice(offset, offset + BATCH_QUERY_CHUNK_SIZE);
        const rows = db.prepare(`
          SELECT generation_run_id, pack_fingerprint FROM studio_generation_dispatches
          WHERE generation_run_id IN (${sqlPlaceholders(chunk.length)})
        `).all(...chunk) as unknown as Array<{ generation_run_id: string; pack_fingerprint: string }>;
        for (const row of rows) {
          if (!packFingerprintByRunId.has(row.generation_run_id)) {
            packFingerprintByRunId.set(row.generation_run_id, row.pack_fingerprint);
          }
        }
      }
    }

    // 3. 逐单元闭合核验（文件系统部分；串行足够快：每单元数次 lstat + 一次小包 JSON 读取）。
    const revisionByUnit = new Map(input.units.map((unit) => [unit.unitId, unit.revision]));
    const mediaCasRoot = shell.paths.mediaCas;
    const historicalPassByUnit = new Map<string, StudioHistoricalPassCandidate>();
    for (const [unitId, row] of latestImportByUnit) {
      const failures: string[] = [];
      // 历史记录自带 PASS 状态
      if (!/^PASS(?:_WITH_P2)?$/u.test(row.external_storyboard_status)) {
        failures.push(`外部机械状态非 PASS：${row.external_storyboard_status}`);
      }
      // 修订当前性：旧修订历史 PASS 不冒充当前修订
      const currentRevision = revisionByUnit.get(unitId);
      if (currentRevision === undefined || Number(row.unit_revision) !== currentRevision) {
        failures.push(`历史导入修订 r${Number(row.unit_revision)} 与当前修订 r${currentRevision ?? "?"} 不一致`);
      }
      // frozen pack/packFingerprint 匹配
      if (!row.pack_content_relpath) {
        failures.push("冻结包行缺失或 pack_fingerprint 不匹配");
      }
      // SHA 一致（行内 raw===source，导入合同保留源原字节）
      if (row.raw_media_sha256 !== row.source_raw_sha256
        || row.labeled_media_sha256 !== row.source_labeled_sha256) {
        failures.push("raw/labeled 与 source SHA 不一致（非原字节证据）");
      }
      // raw/labeled 可读（CAS 寻址存在性）
      if (!(await casObjectReadable(mediaCasRoot, row.raw_media_sha256))) {
        failures.push("raw 媒体 CAS 对象不可读");
      }
      if (!(await casObjectReadable(mediaCasRoot, row.labeled_media_sha256))) {
        failures.push("labeled 媒体 CAS 对象不可读");
      }
      // 参考闭包完整：冻结包 JSON 可读且 controlReferences 媒体均命中 CAS
      if (row.pack_content_relpath) {
        // content_relpath 必须解析到工程根之内（防越界读取）
        const projectRootResolved = path.resolve(shell.paths.root);
        const packPath = path.resolve(projectRootResolved, row.pack_content_relpath);
        const packPathContained = packPath.startsWith(`${projectRootResolved}${path.sep}`);
        if (!packPathContained) {
          failures.push("冻结包路径越出工程根");
        } else {
          try {
            const packStat = await lstat(packPath);
            if (!packStat.isFile() || packStat.size <= 0 || packStat.size > MAX_PACK_JSON_BYTES) {
              failures.push("冻结包 JSON 不可读或尺寸异常");
            } else {
              const pack = JSON.parse(await readFile(packPath, "utf8")) as {
                controlReferences?: Array<{ mediaSha256?: unknown }>;
              };
              const references = Array.isArray(pack.controlReferences) ? pack.controlReferences : [];
              for (const reference of references) {
                const mediaSha256 = typeof reference.mediaSha256 === "string" ? reference.mediaSha256 : "";
                if (!(await casObjectReadable(mediaCasRoot, mediaSha256))) {
                  failures.push(`参考闭包媒体不可读：${mediaSha256.slice(0, 12) || "缺失 SHA"}`);
                }
              }
            }
          } catch {
            failures.push("冻结包 JSON 读取/解析失败");
          }
        }
      }
      historicalPassByUnit.set(unitId, {
        unitId,
        importId: row.import_id,
        packId: row.pack_id,
        packFingerprint: row.pack_fingerprint,
        unitRevision: Number(row.unit_revision),
        rawMediaSha256: row.raw_media_sha256,
        labeledMediaSha256: row.labeled_media_sha256,
        externalStoryboardStatus: row.external_storyboard_status,
        verificationFailures: failures,
        verified: failures.length === 0,
      });
    }

    return { historicalPassByUnit, packFingerprintByRunId };
  } finally {
    await snapshot.close();
  }
}
