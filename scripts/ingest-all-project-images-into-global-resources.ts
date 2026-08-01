/**
 * 将 2026-07-28 全项目图片审计中发现的 61 张“正式但尚未受管”图片补入
 * Material Studio/CAS，使总资源的只读联邦目录能够完整看到它们。
 *
 * 边界：
 * - 旧第三季工程只读；仅允许 assets / authorities / production 三棵正式树。
 * - 明确排除旧工程 .aicanvas 中的候选、暂存与派生图片。
 * - 受管工程漏图使用显式白名单，不做启动扫描或后台 watcher。
 * - 所有媒体写入都走 import_studio_media 命令总线。
 * - 本脚本不创建规范资产、不改变 Review / Primary、不写入画布节点。
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { executeIdempotentCommand } from "../src/core/command-bus.js";
import {
  inspectManagedProjectReadOnly,
  readManagedProjectBootstrapClaim,
  type ProjectShell,
} from "../src/core/managed-project.js";
import {
  activateProject,
  createManagedStudioProject,
  getActiveProject,
} from "../src/core/service.js";
import { listRegisteredProjects } from "../src/core/sidecar.js";

const WORKSPACE_ROOT = "/Users/hxx/Documents/无限画布";
const PROJECTS_ROOT = path.join(WORKSPACE_ROOT, "projects");
const LEGACY_ROOT = path.join(
  WORKSPACE_ROOT,
  "productions",
  "gushujuan-s3-f1a688020bfb7af6",
);
const LEGACY_FORMAL_ROOT_NAMES = ["assets", "authorities", "production"] as const;
const LEGACY_EXPECTED_IMAGE_COUNT = 57;
const MANAGED_MISSING_EXPECTED_COUNT = 4;
const EXPECTED_MINIMUM_PROJECT_ENTRIES = 8_854;
const EXPECTED_MINIMUM_UNIQUE_CONTENT = 8_696;
const MIRROR_NAME = "《蜀道山·古蜀卷》第三季·总资源受管镜像";
const MIRROR_SLUG = "global-resource-legacy-gushujuan-s3";
const MIRROR_BOOTSTRAP_PURPOSE = "global-resource-legacy-mirror";
const EVIDENCE_PATH = path.join(
  WORKSPACE_ROOT,
  "docs",
  "evidence",
  "global-image-resource-ingest-20260728.json",
);
const IMAGE_EXTENSIONS = new Set([
  ".avif",
  ".bmp",
  ".gif",
  ".heic",
  ".jpeg",
  ".jpg",
  ".png",
  ".svg",
  ".tif",
  ".tiff",
  ".webp",
]);
const MANAGED_MISSING_ROOT = path.join(
  PROJECTS_ROOT,
  "dudu-gaiden-lock-20260723-12a6516c",
);
const MANAGED_MISSING_RELATIVE_PATHS = [
  "imports/visual-locks/scenes/style-cloudsea_board.jpg",
  "imports/visual-locks/scenes/style-golden-palace_board.jpg",
  "imports/visual-locks/styles/LOCK_R-CINE_approved_daily_family.jpg",
  "imports/visual-locks/styles/LOCK_R-NIGHT_approved_night_battle.jpg",
] as const;

type SourceRecord = {
  sourcePath: string;
  relativePath: string;
  sha256: string;
  sizeBytes: number;
  sourceGroup: "managed-missing" | "legacy-formal";
};

type ProjectAudit = {
  projectId: string;
  projectName: string;
  projectRoot: string;
  imageEntries: number;
  imageSha256: string[];
};

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === ""
    || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function sha256File(filePath: string): Promise<{ sha256: string; sizeBytes: number }> {
  const hash = createHash("sha256");
  let sizeBytes = 0;
  for await (const chunk of createReadStream(filePath)) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    hash.update(bytes);
    sizeBytes += bytes.byteLength;
  }
  return { sha256: hash.digest("hex"), sizeBytes };
}

async function collectImagesRecursively(
  canonicalRoot: string,
  currentRoot: string,
): Promise<string[]> {
  const entries = await readdir(currentRoot, { withFileTypes: true });
  const results: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name, "zh-CN"))) {
    const candidate = path.join(currentRoot, entry.name);
    const metadata = await lstat(candidate);
    if (metadata.isSymbolicLink()) {
      if (entry.isFile() && IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        throw new Error(`正式图片树中发现符号链接，拒绝导入：${candidate}`);
      }
      continue;
    }
    const canonicalCandidate = await realpath(candidate);
    if (!isWithin(canonicalRoot, canonicalCandidate)) {
      throw new Error(`正式图片路径越出只读源根：${candidate}`);
    }
    if (metadata.isDirectory()) {
      results.push(...await collectImagesRecursively(canonicalRoot, canonicalCandidate));
      continue;
    }
    if (metadata.isFile() && IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      if (metadata.size < 1) throw new Error(`正式图片为空文件：${candidate}`);
      results.push(canonicalCandidate);
    }
  }
  return results;
}

async function preflightSources(): Promise<{
  managedMissing: SourceRecord[];
  legacyFormal: SourceRecord[];
}> {
  const canonicalManagedRoot = await realpath(MANAGED_MISSING_ROOT);
  const managedMissing: SourceRecord[] = [];
  for (const relativePath of MANAGED_MISSING_RELATIVE_PATHS) {
    const requested = path.join(canonicalManagedRoot, relativePath);
    const metadata = await lstat(requested);
    const canonical = await realpath(requested);
    if (!metadata.isFile()
      || metadata.isSymbolicLink()
      || !isWithin(canonicalManagedRoot, canonical)
      || metadata.size < 1) {
      throw new Error(`受管工程漏图白名单身份无效：${requested}`);
    }
    const digest = await sha256File(canonical);
    managedMissing.push({
      sourcePath: canonical,
      relativePath,
      ...digest,
      sourceGroup: "managed-missing",
    });
  }
  if (managedMissing.length !== MANAGED_MISSING_EXPECTED_COUNT) {
    throw new Error(`受管工程漏图应为 ${MANAGED_MISSING_EXPECTED_COUNT} 张，实际 ${managedMissing.length} 张。`);
  }

  const canonicalLegacyRoot = await realpath(LEGACY_ROOT);
  const legacyPaths: string[] = [];
  for (const rootName of LEGACY_FORMAL_ROOT_NAMES) {
    const formalRoot = await realpath(path.join(canonicalLegacyRoot, rootName));
    if (!isWithin(canonicalLegacyRoot, formalRoot)) {
      throw new Error(`旧工程正式树越出源根：${formalRoot}`);
    }
    legacyPaths.push(...await collectImagesRecursively(canonicalLegacyRoot, formalRoot));
  }
  legacyPaths.sort((left, right) => left.localeCompare(right, "zh-CN"));
  if (legacyPaths.length !== LEGACY_EXPECTED_IMAGE_COUNT) {
    throw new Error(
      `旧第三季正式树图片应为 ${LEGACY_EXPECTED_IMAGE_COUNT} 张，实际 ${legacyPaths.length} 张；拒绝扩大或截断白名单。`,
    );
  }
  const legacyFormal: SourceRecord[] = [];
  for (const sourcePath of legacyPaths) {
    legacyFormal.push({
      sourcePath,
      relativePath: path.relative(canonicalLegacyRoot, sourcePath).split(path.sep).join("/"),
      ...await sha256File(sourcePath),
      sourceGroup: "legacy-formal",
    });
  }
  const uniqueLegacySha = new Set(legacyFormal.map((entry) => entry.sha256));
  if (uniqueLegacySha.size !== LEGACY_EXPECTED_IMAGE_COUNT) {
    throw new Error(
      `旧第三季正式树应为 ${LEGACY_EXPECTED_IMAGE_COUNT} 个不同图片内容，实际 ${uniqueLegacySha.size} 个。`,
    );
  }
  return { managedMissing, legacyFormal };
}

function sameBootstrapPayload(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const payload = value as Record<string, unknown>;
  return payload.sourceRoot === LEGACY_ROOT
    && payload.expectedImageCount === LEGACY_EXPECTED_IMAGE_COUNT
    && payload.excludedPrivateTree === ".aicanvas";
}

async function findOrCreateMirror(): Promise<ProjectShell> {
  const registered = await listRegisteredProjects();
  const candidates: ProjectShell[] = [];
  for (const project of registered.filter((entry) => entry.name === MIRROR_NAME)) {
    const shell = await inspectManagedProjectReadOnly(project.primaryRoot);
    const claim = await readManagedProjectBootstrapClaim(shell.paths.root);
    if (claim?.purpose === MIRROR_BOOTSTRAP_PURPOSE && sameBootstrapPayload(claim.payload)) {
      candidates.push(shell);
    }
  }
  if (candidates.length > 1) {
    throw new Error("旧第三季总资源镜像存在多个有效受管 owner，拒绝猜测。");
  }
  if (candidates[0]) return candidates[0];
  return createManagedStudioProject({
    parentRoot: PROJECTS_ROOT,
    name: MIRROR_NAME,
    slug: MIRROR_SLUG,
    bootstrapClaim: {
      purpose: MIRROR_BOOTSTRAP_PURPOSE,
      payload: {
        sourceRoot: LEGACY_ROOT,
        expectedImageCount: LEGACY_EXPECTED_IMAGE_COUNT,
        excludedPrivateTree: ".aicanvas",
      },
    },
  });
}

async function importThroughCommandBus(projectRoot: string, source: SourceRecord): Promise<void> {
  const semanticHash = createHash("sha256")
    .update(`${source.sourceGroup}\0${source.relativePath}\0${source.sha256}`, "utf8")
    .digest("hex");
  const requestKey = `global-image-ingest-${semanticHash}`;
  const result = await executeIdempotentCommand(projectRoot, {
    requestId: `${requestKey}-request`,
    idempotencyKey: requestKey,
    request: {
      command: "import_studio_media",
      payload: {
        sourcePath: source.sourcePath,
        kind: "image",
        expectedSha256: source.sha256,
      },
    },
  });
  if (result.status !== "succeeded") {
    throw new Error(
      `图片入库失败：${source.relativePath}；${result.error?.message ?? result.status}`,
    );
  }
  const imported = result.result as {
    sha256?: string;
    kind?: string;
    derivativeStatus?: string;
    thumbnail?: { recipeKey?: string };
  };
  if (imported.sha256 !== source.sha256
    || imported.kind !== "image"
    || imported.derivativeStatus !== "ready"
    || !/^[a-f0-9]{64}$/u.test(imported.thumbnail?.recipeKey ?? "")) {
    throw new Error(`图片命令回包未证明 CAS/缩略图就绪：${source.relativePath}`);
  }
}

async function auditManagedProjects(): Promise<{
  projects: ProjectAudit[];
  projectImageEntries: number;
  uniqueContentSha256: number;
  unavailable: Array<{ projectId: string; projectName: string; projectRoot: string }>;
}> {
  const projects: ProjectAudit[] = [];
  const unavailable: Array<{ projectId: string; projectName: string; projectRoot: string }> = [];
  const globalSha = new Set<string>();
  let projectImageEntries = 0;
  for (const project of await listRegisteredProjects()) {
    let shell: ProjectShell;
    try {
      shell = await inspectManagedProjectReadOnly(project.primaryRoot);
    } catch {
      unavailable.push({
        projectId: project.id,
        projectName: project.name,
        projectRoot: project.primaryRoot,
      });
      continue;
    }
    const db = new DatabaseSync(shell.paths.materialDatabase, { readOnly: true });
    let rows: Array<{
      sha256: string;
      object_relpath: string;
      thumbnail_relpath: string | null;
      derivative_status: string;
    }>;
    try {
      db.exec("PRAGMA query_only = ON");
      rows = db.prepare(`
        SELECT sha256, object_relpath, thumbnail_relpath, derivative_status
        FROM studio_media
        WHERE kind = 'image'
        ORDER BY sha256
      `).all() as typeof rows;
    } finally {
      db.close();
    }
    for (const row of rows) {
      if (!/^[a-f0-9]{64}$/u.test(row.sha256)
        || row.derivative_status !== "ready"
        || !row.thumbnail_relpath) {
        throw new Error(`受管图片记录未就绪：${shell.project.id}:${row.sha256}`);
      }
      const [objectMetadata, thumbnailMetadata] = await Promise.all([
        lstat(path.join(shell.paths.root, row.object_relpath)),
        lstat(path.join(shell.paths.root, row.thumbnail_relpath)),
      ]);
      if (!objectMetadata.isFile()
        || objectMetadata.isSymbolicLink()
        || !thumbnailMetadata.isFile()
        || thumbnailMetadata.isSymbolicLink()
        || objectMetadata.size < 1
        || thumbnailMetadata.size < 1) {
        throw new Error(`受管图片 CAS/缩略图无效：${shell.project.id}:${row.sha256}`);
      }
      globalSha.add(row.sha256);
    }
    projectImageEntries += rows.length;
    projects.push({
      projectId: shell.project.id,
      projectName: shell.project.name,
      projectRoot: shell.paths.root,
      imageEntries: rows.length,
      imageSha256: rows.map((row) => row.sha256),
    });
  }
  return {
    projects,
    projectImageEntries,
    uniqueContentSha256: globalSha.size,
    unavailable,
  };
}

async function countLegacyPrivateImages(): Promise<number> {
  const privateRoot = await realpath(path.join(LEGACY_ROOT, ".aicanvas"));
  return (await collectImagesRecursively(privateRoot, privateRoot)).length;
}

async function main(): Promise<void> {
  const priorActive = await getActiveProject();
  const sources = await preflightSources();
  const hiddenPrivateImageCount = await countLegacyPrivateImages();
  if (hiddenPrivateImageCount !== 72) {
    throw new Error(`旧工程 .aicanvas 隐藏图片应为 72 张，实际 ${hiddenPrivateImageCount} 张；拒绝继续。`);
  }
  let mirror: ProjectShell | undefined;
  try {
    for (const source of sources.managedMissing) {
      await importThroughCommandBus(MANAGED_MISSING_ROOT, source);
    }
    mirror = await findOrCreateMirror();
    for (const source of sources.legacyFormal) {
      await importThroughCommandBus(mirror.paths.root, source);
    }
  } finally {
    if (priorActive?.available) {
      await activateProject(priorActive.primaryRoot).catch(() => undefined);
    }
  }
  if (!mirror) throw new Error("旧第三季总资源镜像未建立。");

  const audit = await auditManagedProjects();
  if (audit.projectImageEntries < EXPECTED_MINIMUM_PROJECT_ENTRIES
    || audit.uniqueContentSha256 < EXPECTED_MINIMUM_UNIQUE_CONTENT) {
    throw new Error(
      `全项目图片覆盖不足：项目条目 ${audit.projectImageEntries} / ${EXPECTED_MINIMUM_PROJECT_ENTRIES}，`
      + `不同 SHA ${audit.uniqueContentSha256} / ${EXPECTED_MINIMUM_UNIQUE_CONTENT}。`,
    );
  }
  const mirrorAudit = audit.projects.find((entry) => entry.projectRoot === mirror!.paths.root);
  const managedMissingAudit = audit.projects.find(
    (entry) => entry.projectRoot === MANAGED_MISSING_ROOT,
  );
  if (mirrorAudit?.imageEntries !== LEGACY_EXPECTED_IMAGE_COUNT) {
    throw new Error(`旧第三季镜像图片应为 ${LEGACY_EXPECTED_IMAGE_COUNT} 张，实际 ${mirrorAudit?.imageEntries ?? 0} 张。`);
  }
  if (!managedMissingAudit
    || sources.managedMissing.some((entry) => !managedMissingAudit.imageSha256.includes(entry.sha256))) {
    throw new Error("受管工程 4 张漏图未全部进入原项目 Material Studio。");
  }

  const evidence = {
    schemaVersion: 1,
    kind: "global-image-resource-ingest-evidence",
    generatedAt: new Date().toISOString(),
    conclusion: "PASS",
    policy: {
      globalCatalog: "federated-registry-project-sqlite-cas",
      sourceMutation: "none",
      importOwner: "executeIdempotentCommand/import_studio_media",
      classificationAuthorityPromotion: "none",
      legacyAllowedRoots: [...LEGACY_FORMAL_ROOT_NAMES],
      legacyExcludedPrivateTree: ".aicanvas",
    },
    imported: {
      managedMissingCount: sources.managedMissing.length,
      legacyFormalCount: sources.legacyFormal.length,
      hiddenLegacyPrivateImagesExcluded: hiddenPrivateImageCount,
      mirrorProjectId: mirror.project.id,
      mirrorProjectName: mirror.project.name,
      mirrorProjectRoot: mirror.paths.root,
      sources: [...sources.managedMissing, ...sources.legacyFormal].map((entry) => ({
        sourceGroup: entry.sourceGroup,
        relativePath: entry.relativePath,
        sha256: entry.sha256,
        sizeBytes: entry.sizeBytes,
      })),
    },
    liveAudit: {
      registeredProjectCount: (await listRegisteredProjects()).length,
      readableManagedProjectCount: audit.projects.length,
      unavailableProjectCount: audit.unavailable.length,
      projectImageEntries: audit.projectImageEntries,
      uniqueContentSha256: audit.uniqueContentSha256,
      expectedMinimumProjectImageEntries: EXPECTED_MINIMUM_PROJECT_ENTRIES,
      expectedMinimumUniqueContentSha256: EXPECTED_MINIMUM_UNIQUE_CONTENT,
      unavailable: audit.unavailable,
    },
  };
  await mkdir(path.dirname(EVIDENCE_PATH), { recursive: true });
  await writeFile(EVIDENCE_PATH, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  const landed = JSON.parse(await readFile(EVIDENCE_PATH, "utf8")) as typeof evidence;
  if (landed.conclusion !== "PASS"
    || landed.liveAudit.projectImageEntries !== audit.projectImageEntries) {
    throw new Error("全项目图片入库证据落盘后复读失败。");
  }
  process.stdout.write(`${JSON.stringify({
    conclusion: landed.conclusion,
    mirrorProjectRoot: mirror.paths.root,
    projectImageEntries: audit.projectImageEntries,
    uniqueContentSha256: audit.uniqueContentSha256,
    hiddenLegacyPrivateImagesExcluded: hiddenPrivateImageCount,
    evidencePath: EVIDENCE_PATH,
  }, null, 2)}\n`);
}

await main();
