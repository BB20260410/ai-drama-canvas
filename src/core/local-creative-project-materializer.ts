import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { withFileLock } from "./locks.js";
import {
  createManagedProject,
  inspectManagedProjectReadOnly,
  isManagedProject,
  managedProjectSlug,
  readManagedProjectBootstrapClaim,
  reconcileManagedProjectBootstrapRecovery,
  resumeManagedProjectBootstrap,
  resumeManagedProjectBootstrapFromQuarantine,
  type ManagedProjectBootstrapClaim,
  type ProjectShell,
} from "./managed-project.js";
import { ensureManagedProjectCreatedEvent } from "./service.js";
import {
  loadIndex,
  loadProjectConfig,
  listRegisteredProjects,
  registerProject,
  writeJsonAtomic,
} from "./sidecar.js";

const BOOTSTRAP_PURPOSE = "local-creative-import";
const INGEST_MANIFEST_RELATIVE_PATH = ".aicanvas/local-creative-project-ingest.json";
const MATERIALIZER_LOCK_DIRECTORY = ".aicanvas-local-import-locks";
const MATERIALIZER_LOCK_NAME = "local-creative-project-materializer";

function maybeInterruptLocalProjectMaterializerForTests(
  phase: "after-ingest-before-register",
): void {
  if (process.env.NODE_ENV === "test"
    && process.env.AI_CANVAS_TEST_LOCAL_PROJECT_MATERIALIZER_INTERRUPT === phase) {
    throw new Error(`test-only local project materializer interruption: ${phase}`);
  }
}

export type LocalCreativeProjectResolution = "CREATE_MANAGED" | "CREATE_INBOX" | "REUSE_READONLY";

export type LocalCreativeJsonValue =
  | string
  | number
  | boolean
  | null
  | LocalCreativeJsonValue[]
  | { [key: string]: LocalCreativeJsonValue };

export interface LocalCreativeProjectSource {
  root: string;
  role: string;
  maxDepth?: number;
  excludeRelativePrefixes?: string[];
}

/**
 * `projectType` 与 catalog 当前字段兼容；`type` 是规范描述的简写。二者同时提供时
 * 必须一致，避免不同调用方把同一个 project key 解释成两种工程。
 */
export interface LocalCreativeProjectDescriptor {
  key: string;
  name: string;
  type?: string;
  projectType?: string;
  resolution: LocalCreativeProjectResolution;
  sources: LocalCreativeProjectSource[];
  managedProjectRoot?: string;
  authorityPolicy?: string;
  scanSummary?: Record<string, LocalCreativeJsonValue>;
}

export interface LocalCreativeProjectSourceLayer {
  order: number;
  root: string;
  role: string;
  maxDepth?: number;
  excludeRelativePrefixes?: string[];
}

export interface LocalCreativeProjectIngestManifest {
  schemaVersion: 1;
  kind: "local-creative-project-ingest";
  project: {
    key: string;
    name: string;
    type: string;
    resolution: Exclude<LocalCreativeProjectResolution, "REUSE_READONLY">;
    projectId: string;
    projectRoot: string;
  };
  sourceLayers: LocalCreativeProjectSourceLayer[];
  authorityPolicy: string;
  scanSummary: Record<string, LocalCreativeJsonValue>;
  bootstrapClaimFingerprint: string;
  recordedAt: string;
  fingerprint: string;
}

export interface MaterializeLocalCreativeProjectInput {
  projectsRoot: string;
  project: LocalCreativeProjectDescriptor;
}

export interface MaterializeLocalCreativeProjectResult {
  projectRoot: string;
  projectId: string;
  resolution: LocalCreativeProjectResolution;
  disposition: "created" | "resumed" | "reused" | "reused-readonly";
  registered: boolean;
  ingestManifestPath: string | null;
  projectFormat: "managed" | "legacy";
  shell: ProjectShell | null;
}

interface NormalizedDescriptor {
  key: string;
  name: string;
  type: string;
  resolution: LocalCreativeProjectResolution;
  sources: LocalCreativeProjectSourceLayer[];
  managedProjectRoot?: string;
  authorityPolicy: string;
  scanSummary: Record<string, LocalCreativeJsonValue>;
}

interface ManagedCandidate {
  root: string;
  claim: ManagedProjectBootstrapClaim | null;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableValue(value: LocalCreativeJsonValue): LocalCreativeJsonValue {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => [key, stableValue(entry)]));
}

function normalizeJsonValue(value: unknown, label: string): LocalCreativeJsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${label} 含非有限数值。`);
    return value;
  }
  if (Array.isArray(value)) return value.map((entry, index) => normalizeJsonValue(entry, `${label}[${index}]`));
  if (!value || typeof value !== "object") throw new Error(`${label} 必须是 JSON 可序列化值。`);
  const record = value as Record<string, unknown>;
  const normalized: Record<string, LocalCreativeJsonValue> = {};
  for (const key of Object.keys(record).sort((left, right) => left.localeCompare(right))) {
    if (!key.normalize("NFC").trim()) throw new Error(`${label} 含空键。`);
    normalized[key] = normalizeJsonValue(record[key], `${label}.${key}`);
  }
  return normalized;
}

function normalizeIdentifier(value: unknown, label: string): string {
  const normalized = typeof value === "string" ? value.normalize("NFC").trim() : "";
  if (!/^[a-z][a-z0-9-]{1,79}$/u.test(normalized)) {
    throw new Error(`${label} 必须是 2–80 位小写字母、数字或连字符标识。`);
  }
  return normalized;
}

function normalizeName(value: unknown): string {
  const normalized = typeof value === "string" ? value.normalize("NFC").trim() : "";
  if (!normalized || normalized.length > 160) throw new Error("project.name 必须是 1–160 个字符。");
  return normalized;
}

function normalizeUpperIdentifier(value: unknown, label: string): string {
  const normalized = typeof value === "string" ? value.normalize("NFC").trim() : "";
  if (!/^[A-Z][A-Z0-9_]{1,79}$/u.test(normalized)) {
    throw new Error(`${label} 必须是 2–80 位大写字母、数字或下划线标识。`);
  }
  return normalized;
}

function normalizeRelativePrefix(value: unknown, label: string): string {
  const normalized = typeof value === "string"
    ? value.normalize("NFC").trim().replaceAll("\\", "/").replace(/^\.\/+/u, "").replace(/\/+$/u, "")
    : "";
  if (!normalized || path.posix.isAbsolute(normalized)
    || normalized.split("/").some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error(`${label} 必须是项目根内的安全相对前缀。`);
  }
  return normalized;
}

async function canonicalRealDirectory(value: unknown, label: string): Promise<string> {
  const provided = typeof value === "string" ? value.normalize("NFC").trim() : "";
  if (!provided) throw new Error(`${label} 不能为空。`);
  const absolute = path.resolve(provided);
  const metadata = await lstat(absolute).catch((error: unknown) => {
    throw new Error(`${label} 不存在或不可读：${absolute}`, { cause: error });
  });
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error(`${label} 必须是真实目录，不能是符号链接：${absolute}`);
  const canonical = await realpath(absolute);
  if (canonical !== absolute) throw new Error(`${label} 路径含符号链接或别名：${absolute}`);
  return canonical;
}

function rootsOverlap(left: string, right: string): boolean {
  const relative = path.relative(left, right);
  if (!relative) return true;
  if (!relative.startsWith("..") && !path.isAbsolute(relative)) return true;
  const reverse = path.relative(right, left);
  return !reverse.startsWith("..") && !path.isAbsolute(reverse);
}

async function normalizeDescriptor(
  input: LocalCreativeProjectDescriptor,
  projectsRoot: string,
): Promise<NormalizedDescriptor> {
  if (!input || typeof input !== "object") throw new Error("project 必须是规范项目描述。");
  const key = normalizeIdentifier(input.key, "project.key");
  const name = normalizeName(input.name);
  const declaredTypes = [input.type, input.projectType]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map((value) => normalizeIdentifier(value, "project.type"));
  if (declaredTypes.length === 0) throw new Error("project.type 或 project.projectType 至少提供一个。");
  if (new Set(declaredTypes).size !== 1) throw new Error("project.type 与 project.projectType 不一致。");
  const projectType = declaredTypes[0]!;
  if (!["CREATE_MANAGED", "CREATE_INBOX", "REUSE_READONLY"].includes(input.resolution)) {
    throw new Error("project.resolution 无效。");
  }
  if (!Array.isArray(input.sources) || input.sources.length === 0) throw new Error("project.sources 至少包含一个来源层。");

  const sources: LocalCreativeProjectSourceLayer[] = [];
  const seenRoots = new Set<string>();
  for (const [index, source] of input.sources.entries()) {
    if (!source || typeof source !== "object") throw new Error(`project.sources[${index}] 格式无效。`);
    const root = await canonicalRealDirectory(source.root, `project.sources[${index}].root`);
    if (rootsOverlap(root, projectsRoot)) {
      throw new Error(`来源目录与受管 projectsRoot 重叠，无法保证源只读：${root}`);
    }
    if (seenRoots.has(root)) throw new Error(`project.sources 含重复来源根：${root}`);
    seenRoots.add(root);
    const role = normalizeUpperIdentifier(source.role, `project.sources[${index}].role`);
    const maxDepth = source.maxDepth;
    if (maxDepth !== undefined && (!Number.isInteger(maxDepth) || maxDepth < 1 || maxDepth > 64)) {
      throw new Error(`project.sources[${index}].maxDepth 必须是 1–64 的整数。`);
    }
    const excludeRelativePrefixes = source.excludeRelativePrefixes?.map((entry, prefixIndex) =>
      normalizeRelativePrefix(entry, `project.sources[${index}].excludeRelativePrefixes[${prefixIndex}]`));
    sources.push({
      order: index,
      root,
      role,
      ...(maxDepth === undefined ? {} : { maxDepth }),
      ...(!excludeRelativePrefixes || excludeRelativePrefixes.length === 0
        ? {}
        : { excludeRelativePrefixes: [...new Set(excludeRelativePrefixes)] }),
    });
  }

  const authorityPolicy = input.authorityPolicy === undefined
    ? input.resolution === "CREATE_INBOX" ? "FORBID_ALL" : "EVIDENCE_REQUIRED"
    : normalizeUpperIdentifier(input.authorityPolicy, "project.authorityPolicy");
  if (input.resolution === "CREATE_INBOX" && authorityPolicy !== "FORBID_ALL") {
    throw new Error("CREATE_INBOX 的 authorityPolicy 必须是 FORBID_ALL。");
  }
  const scanSummaryValue = normalizeJsonValue(input.scanSummary ?? {}, "project.scanSummary");
  if (!scanSummaryValue || Array.isArray(scanSummaryValue) || typeof scanSummaryValue !== "object") {
    throw new Error("project.scanSummary 必须是 JSON 对象。");
  }
  const managedProjectRoot = input.resolution === "REUSE_READONLY"
    ? await canonicalRealDirectory(input.managedProjectRoot, "project.managedProjectRoot")
    : undefined;
  if (input.resolution === "REUSE_READONLY" && !managedProjectRoot) {
    throw new Error("REUSE_READONLY 必须提供 managedProjectRoot。");
  }
  return {
    key,
    name,
    type: projectType,
    resolution: input.resolution,
    sources,
    managedProjectRoot,
    authorityPolicy,
    scanSummary: stableValue(scanSummaryValue) as Record<string, LocalCreativeJsonValue>,
  };
}

function bootstrapPayload(descriptor: NormalizedDescriptor): Record<string, unknown> {
  return {
    schemaVersion: 1,
    projectKey: descriptor.key,
    projectName: descriptor.name,
    projectType: descriptor.type,
    resolution: descriptor.resolution,
  };
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function assertExpectedClaim(
  claim: ManagedProjectBootstrapClaim,
  descriptor: NormalizedDescriptor,
  projectRoot: string,
): void {
  const expectedPayload = bootstrapPayload(descriptor);
  if (claim.purpose !== BOOTSTRAP_PURPOSE || !sameJson(stableValue(claim.payload as LocalCreativeJsonValue), stableValue(expectedPayload as LocalCreativeJsonValue))) {
    throw new Error(`local import bootstrap claim 与项目描述不一致：${projectRoot}`);
  }
}

function candidateRootName(name: string, slug: string): boolean {
  if (name === slug) return true;
  if (!name.startsWith(`${slug}-`)) return false;
  return /^[a-f0-9]{8}$/u.test(name.slice(slug.length + 1));
}

async function discoverCandidates(
  projectsRoot: string,
  descriptor: NormalizedDescriptor,
  slug: string,
): Promise<ManagedCandidate[]> {
  const entries = await readdir(projectsRoot, { withFileTypes: true });
  const candidates: ManagedCandidate[] = [];
  for (const entry of entries) {
    if (!candidateRootName(entry.name, slug)) continue;
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error(`local import 候选根不是安全真实目录：${path.join(projectsRoot, entry.name)}`);
    }
    const root = path.join(projectsRoot, entry.name);
    const claim = await readManagedProjectBootstrapClaim(root);
    if (claim) assertExpectedClaim(claim, descriptor, root);
    candidates.push({ root, claim });
  }
  if (candidates.length > 1) {
    throw new Error(`同一 project key 存在多个 local import 根，禁止猜测：${candidates.map((entry) => entry.root).join(", ")}`);
  }
  return candidates;
}

async function discoverOrCreateManagedProject(
  projectsRoot: string,
  descriptor: NormalizedDescriptor,
): Promise<{ shell: ProjectShell; disposition: "created" | "resumed" | "reused"; claim: ManagedProjectBootstrapClaim }> {
  const slug = managedProjectSlug(`local-import-${descriptor.key}`);
  const options = {
    name: descriptor.name,
    bootstrapClaim: {
      purpose: BOOTSTRAP_PURPOSE,
      payload: bootstrapPayload(descriptor),
    },
  };
  const candidates = await discoverCandidates(projectsRoot, descriptor, slug);
  if (candidates.length === 0) {
    const recovered = await resumeManagedProjectBootstrapFromQuarantine(projectsRoot, {
      slug,
      ...options,
    });
    if (recovered) {
      const claim = await readManagedProjectBootstrapClaim(recovered.paths.root);
      if (!claim) throw new Error(`恢复后的 local import 工程缺少 bootstrap claim：${recovered.paths.root}`);
      assertExpectedClaim(claim, descriptor, recovered.paths.root);
      return { shell: recovered, disposition: "resumed", claim };
    }
    const shell = await createManagedProject({ parentRoot: projectsRoot, slug, ...options });
    const claim = await readManagedProjectBootstrapClaim(shell.paths.root);
    if (!claim) throw new Error(`新建 local import 工程缺少 bootstrap claim：${shell.paths.root}`);
    assertExpectedClaim(claim, descriptor, shell.paths.root);
    return { shell, disposition: "created", claim };
  }

  const candidate = candidates[0]!;
  let completed = true;
  let shell = await inspectManagedProjectReadOnly(candidate.root).catch(() => {
    completed = false;
    return null;
  });
  if (!shell) {
    shell = await resumeManagedProjectBootstrap(candidate.root, options);
  }
  const claim = await readManagedProjectBootstrapClaim(shell.paths.root);
  if (!claim) throw new Error(`local import 工程缺少 bootstrap claim：${shell.paths.root}`);
  assertExpectedClaim(claim, descriptor, shell.paths.root);
  if (shell.project.name !== descriptor.name.normalize("NFKC")) {
    throw new Error(`local import 工程名称与项目描述不一致：${shell.paths.root}`);
  }
  return { shell, disposition: completed ? "reused" : "resumed", claim };
}

async function ensureRegisteredWithoutActivation(shell: ProjectShell): Promise<boolean> {
  const registry = await listRegisteredProjects();
  const sameRoot = registry.filter((entry) => path.resolve(entry.primaryRoot) === shell.paths.root);
  const sameId = registry.filter((entry) => entry.id === shell.project.id);
  if (sameRoot.length > 1 || sameId.length > 1) throw new Error(`受管工程注册身份重复：${shell.paths.root}`);
  if (sameRoot.length === 1 || sameId.length === 1) {
    if (sameRoot.length !== 1 || sameId.length !== 1
      || sameRoot[0]!.id !== shell.project.id || sameRoot[0]!.name !== shell.project.name
      || sameId[0]!.primaryRoot !== shell.paths.root) {
      throw new Error(`受管工程注册身份冲突，禁止覆盖：${shell.paths.root}`);
    }
    return true;
  }
  await registerProject(shell.project);
  return true;
}

function buildIngestManifest(
  shell: ProjectShell,
  descriptor: NormalizedDescriptor,
  claim: ManagedProjectBootstrapClaim,
): LocalCreativeProjectIngestManifest {
  if (descriptor.resolution === "REUSE_READONLY") throw new Error("REUSE_READONLY 不写 ingest manifest。");
  const semantic: Omit<LocalCreativeProjectIngestManifest, "fingerprint"> = {
    schemaVersion: 1,
    kind: "local-creative-project-ingest",
    project: {
      key: descriptor.key,
      name: shell.project.name,
      type: descriptor.type,
      resolution: descriptor.resolution,
      projectId: shell.project.id,
      projectRoot: shell.paths.root,
    },
    sourceLayers: descriptor.sources.map((source) => ({ ...source })),
    authorityPolicy: descriptor.authorityPolicy,
    scanSummary: descriptor.scanSummary,
    bootstrapClaimFingerprint: claim.fingerprint,
    recordedAt: shell.project.createdAt,
  };
  return {
    ...semantic,
    fingerprint: sha256(JSON.stringify(stableValue(semantic as unknown as LocalCreativeJsonValue))),
  };
}

async function writeIngestManifestIfChanged(
  shell: ProjectShell,
  manifest: LocalCreativeProjectIngestManifest,
): Promise<string> {
  const manifestPath = path.join(shell.paths.root, INGEST_MANIFEST_RELATIVE_PATH);
  const next = `${JSON.stringify(manifest, null, 2)}\n`;
  const current = await readFile(manifestPath, "utf8").catch((error: unknown) => {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
  if (current !== next) await writeJsonAtomic(manifestPath, manifest);
  const verified = await readFile(manifestPath, "utf8");
  if (verified !== next) throw new Error(`local creative ingest manifest 原子写入复验失败：${manifestPath}`);
  return manifestPath;
}

/**
 * 将规范项目描述幂等物化为独立受管工程。该入口只读取 sourceLayers；所有写入
 * 都限制在 projectsRoot、项目自身 sidecar 和隔离 registry 中，且从不修改活动项目。
 */
export async function materializeLocalCreativeProject(
  input: MaterializeLocalCreativeProjectInput,
): Promise<MaterializeLocalCreativeProjectResult> {
  if (!input || typeof input !== "object") throw new Error("materialize input 格式无效。");
  const projectsRoot = await canonicalRealDirectory(input.projectsRoot, "projectsRoot");
  const descriptor = await normalizeDescriptor(input.project, projectsRoot);

  if (descriptor.resolution === "REUSE_READONLY") {
    const projectRoot = descriptor.managedProjectRoot!;
    if (!await isManagedProject(projectRoot)) {
      const [project, index] = await Promise.all([
        loadProjectConfig(projectRoot),
        loadIndex(projectRoot),
      ]);
      if (path.resolve(project.primaryRoot) !== projectRoot) {
        throw new Error(`legacy 工程 primaryRoot 与复用根不一致：${projectRoot}`);
      }
      if (!index || index.project.id !== project.id || path.resolve(index.project.primaryRoot) !== projectRoot) {
        throw new Error(`legacy 工程 index 与 project 身份不一致：${projectRoot}`);
      }
      return {
        projectRoot,
        projectId: project.id,
        resolution: descriptor.resolution,
        disposition: "reused-readonly",
        registered: false,
        ingestManifestPath: null,
        projectFormat: "legacy",
        shell: null,
      };
    }
    const shell = await inspectManagedProjectReadOnly(projectRoot);
    return {
      projectRoot: shell.paths.root,
      projectId: shell.project.id,
      resolution: descriptor.resolution,
      disposition: "reused-readonly",
      registered: false,
      ingestManifestPath: null,
      projectFormat: "managed",
      shell,
    };
  }

  return withFileLock(
    path.join(projectsRoot, MATERIALIZER_LOCK_DIRECTORY),
    MATERIALIZER_LOCK_NAME,
    async () => {
      const managed = await discoverOrCreateManagedProject(projectsRoot, descriptor);
      await reconcileManagedProjectBootstrapRecovery(managed.shell.paths.root);
      const ingestManifest = buildIngestManifest(managed.shell, descriptor, managed.claim);
      const ingestManifestPath = await writeIngestManifestIfChanged(managed.shell, ingestManifest);
      maybeInterruptLocalProjectMaterializerForTests("after-ingest-before-register");
      await ensureManagedProjectCreatedEvent(managed.shell);
      const registered = await ensureRegisteredWithoutActivation(managed.shell);
      return {
        projectRoot: managed.shell.paths.root,
        projectId: managed.shell.project.id,
        resolution: descriptor.resolution,
        disposition: managed.disposition,
        registered,
        ingestManifestPath,
        projectFormat: "managed",
        shell: managed.shell,
      };
    },
    { confinementRoot: projectsRoot },
  );
}
