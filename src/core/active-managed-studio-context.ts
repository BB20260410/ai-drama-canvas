import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { resolveRuntimeBuildIdentity, type BuildIdentity } from "./build-identity.js";
import { findRuntimeReleaseManifestPath } from "./release-manifest.js";
import { readActiveManagedStudioProjection } from "./active-managed-studio-read-projection.js";
import { inspectManagedProjectReadOnly } from "./managed-project.js";
import {
  getActiveProjectRegistrationSnapshotReadOnly,
  type ActiveStudioFocus,
  type ActiveStudioMode,
} from "./sidecar.js";
import { type StudioDashboardNextAction } from "./studio-production-dashboard.js";
import { getStudioProjectWriteLeaseReadOnly } from "./studio-project-write-lease.js";

export const ACTIVE_MANAGED_STUDIO_CONTEXT_SCHEMA_VERSION = 1 as const;

export type ActiveManagedStudioContextErrorCode =
  | "active-project-missing"
  | "active-project-unavailable"
  | "active-project-unregistered"
  | "active-project-not-managed"
  | "active-project-identity-conflict"
  | "build-currentness-mismatch"
  | "project-context-token-mismatch";

export class ActiveManagedStudioContextError extends Error {
  readonly code: ActiveManagedStudioContextErrorCode;

  constructor(code: ActiveManagedStudioContextErrorCode, message: string) {
    super(message);
    this.name = "ActiveManagedStudioContextError";
    this.code = code;
  }
}

export interface ActiveManagedStudioContext {
  schemaVersion: typeof ACTIVE_MANAGED_STUDIO_CONTEXT_SCHEMA_VERSION;
  kind: "active-managed-studio-context";
  projectId: string;
  projectName: string;
  projectRoot: string;
  manifestFingerprint: string;
  projectContextToken: string;
  build: {
    buildId: string;
    sourceDigest: string;
    buildAllowed: true;
    packageVersion: string;
  };
  ui: {
    mode: ActiveStudioMode;
    focus?: ActiveStudioFocus;
    updatedAt: string;
  };
  nextAction: StudioDashboardNextAction;
  counts: {
    units: number;
    panels: number;
    canonicalAssets: number;
    characters: number;
    scenes: number;
    props: number;
    styles: number;
    media: number;
    bindingSets: number;
  };
  queueTotals: Record<"ambiguity" | "missing" | "stale" | "conflict" | "rework", number | "bounded-partial">;
  lockedAssetSample: Array<{
    assetId: string;
    name: string;
    category: "character" | "scene" | "prop" | "style";
    revision: number;
    currentness: string;
  }>;
  agentExecution: {
    executorKind: "agent-imagegen";
    providers: readonly ["codex", "grok"];
    prompt: "managed_studio_lock_generate_writeback";
    writes: "execute_command-only";
  };
  /** 跨代理写租约投影；held 时异主禁止生图相关 execute_command */
  writeLease: {
    held: boolean;
    expired: boolean;
    holderId: string | null;
    holderKind: string | null;
    expiresAt: string | null;
    denialHint: string | null;
  };
  fingerprint: string;
}

export interface ActiveManagedStudioContextOptions {
  /**
   * MCP wrapper 已完成构建当前性校验时注入，避免活动上下文内部再次整仓摘要。
   * 省略时保持桌面/测试调用的既有行为。
   */
  runtimeBuildIdentity?: BuildIdentity;
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right, "en"))
    .map(([key, entry]) => [key, stable(entry)]));
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(stable(value)), "utf8").digest("hex");
}

async function isWorkspaceRoot(candidate: string): Promise<boolean> {
  try {
    const pkg = JSON.parse(await readFile(path.join(candidate, "package.json"), "utf8")) as { name?: string };
    return pkg.name === "ai-drama-canvas";
  } catch {
    return false;
  }
}

export async function resolveAiCanvasWorkspaceRoot(): Promise<string> {
  // 安装版的 MCP 位于 app.asar.unpacked，源码 package.json 位于 asar 内，
  // 不能再用开发态工作区探测。release manifest 已由安装包签名边界保护，
  // 其 Resources 目录就是安装态构建身份根。
  const runtimeManifestPath = await findRuntimeReleaseManifestPath();
  if (runtimeManifestPath) return path.dirname(runtimeManifestPath);
  const moduleRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const candidates = [
    process.env.AI_CANVAS_WORKSPACE,
    moduleRoot,
    process.cwd(),
  ].filter((entry): entry is string => Boolean(entry)).map((entry) => path.resolve(entry));
  for (const candidate of [...new Set(candidates)]) {
    if (await isWorkspaceRoot(candidate)) return candidate;
  }
  throw new ActiveManagedStudioContextError(
    "build-currentness-mismatch",
    "无法定位 AI 漫剧画布构建身份；请使用当前安装版或重新构建 MCP。",
  );
}

function contextTokenBody(input: {
  projectId: string;
  projectRoot: string;
  manifestFingerprint: string;
  activationId: string;
  buildId: string;
  sourceDigest: string;
}) {
  return {
    schemaVersion: ACTIVE_MANAGED_STUDIO_CONTEXT_SCHEMA_VERSION,
    projectId: input.projectId,
    projectRoot: path.resolve(input.projectRoot),
    manifestFingerprint: input.manifestFingerprint,
    activationId: input.activationId,
    buildId: input.buildId,
    sourceDigest: input.sourceDigest,
  };
}

function isTransientManagedContextRace(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return /snapshot|WAL|冻结验证|隔离快照|source identity|changed while|safe regular file|database is locked|generation ledger/i.test(msg);
}

export async function failSoftAfter<T>(operation: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} 超过 ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 同一 key 的慢读取共享一条底层任务。调用方可以各自 fail-soft 超时，但超时不会
 * 清除仍在执行的底层任务；后续请求继续复用它，直到真正 resolve/reject 后才允许重试。
 */
export function createSharedAsyncSingleFlight<Key, Value>(
  load: (key: Key) => Promise<Value>,
): (key: Key) => Promise<Value> {
  const flights = new Map<Key, Promise<Value>>();
  return (key) => {
    const existing = flights.get(key);
    if (existing) return existing;
    const pending = Promise.resolve().then(() => load(key));
    flights.set(key, pending);
    void pending.then(
      () => {
        if (flights.get(key) === pending) flights.delete(key);
      },
      () => {
        if (flights.get(key) === pending) flights.delete(key);
      },
    );
    return pending;
  };
}

export async function getActiveManagedStudioContext(
  options: ActiveManagedStudioContextOptions = {},
): Promise<ActiveManagedStudioContext> {
  const maxAttempts = 10;
  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await getActiveManagedStudioContextOnce(options);
    } catch (error) {
      lastError = error;
      // Permanent identity/token errors fail immediately; ledger snapshot races under Electron retry.
      if (error instanceof ActiveManagedStudioContextError
        && error.code !== "active-project-not-managed"
        && error.code !== "active-project-unavailable") {
        throw error;
      }
      if (!isTransientManagedContextRace(error) || attempt === maxAttempts - 1) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50 * Math.pow(1.4, attempt) + Math.random() * 40));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function getActiveManagedStudioContextOnce(
  options: ActiveManagedStudioContextOptions,
): Promise<ActiveManagedStudioContext> {
  const {
    state: activeState,
    registration,
  } = await getActiveProjectRegistrationSnapshotReadOnly();
  if (!activeState) {
    throw new ActiveManagedStudioContextError("active-project-missing", "桌面软件尚未选择活动工程。请先在项目中心打开一个受管工程。");
  }
  if (!registration) {
    throw new ActiveManagedStudioContextError("active-project-unregistered", "活动工程不在共享项目注册表中，已停止自动选择。");
  }
  const activeRoot = path.resolve(activeState.primaryRoot);
  if (path.resolve(registration.primaryRoot) !== activeRoot) {
    throw new ActiveManagedStudioContextError("active-project-identity-conflict", "活动工程指针与项目注册表不一致，已停止自动连接。");
  }
  try {
    await access(activeRoot);
  } catch {
    throw new ActiveManagedStudioContextError("active-project-unavailable", `活动工程暂时不可访问：${activeRoot}`);
  }

  let shell: Awaited<ReturnType<typeof inspectManagedProjectReadOnly>>;
  try {
    // 活动工程上下文仅做身份、令牌与画布读取前置校验；不得在此初始化
    // generation ledger，否则只读连接会被独立账本恢复/锁竞争拖住。
    // 所有实际写入仍在各自 execute_command 路径中初始化并复核账本。
    shell = await inspectManagedProjectReadOnly(activeRoot);
  } catch (error) {
    throw new ActiveManagedStudioContextError(
      "active-project-not-managed",
      `活动工程没有通过受管工程完整性校验：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (shell.project.id !== registration.id) {
    throw new ActiveManagedStudioContextError("active-project-identity-conflict", "活动工程 manifest 与注册表 projectId 不一致，已停止自动连接。");
  }

  // MCP wrapper 可注入已核验身份，避免同一请求再次整仓摘要；桌面/测试默认调用
  // 仍从当前源码或 release manifest 计算，保持兼容与失败关闭。
  const identity = options.runtimeBuildIdentity ?? await (async () => {
    const workspace = await resolveAiCanvasWorkspaceRoot();
    // 开发态从当前源码计算；安装态从 App 签名保护的
    // release-manifest 取构建身份，不要假设安装包内仍有 src/tests/scripts。
    return resolveRuntimeBuildIdentity(workspace);
  })();
  const recorded = process.env.AI_CANVAS_RECORDED_SOURCE_DIGEST?.trim();
  if (recorded && recorded !== identity.sourceDigest) {
    throw new ActiveManagedStudioContextError(
      "build-currentness-mismatch",
      "MCP 构建身份与当前源码不一致；请在桌面软件的 Agent 连接页修复后重试。",
    );
  }

  // 活动上下文只读取素材库/生产库的既有事实，不打开 generation ledger，也不调用
  // 会初始化/迁移数据库的 dashboard owner。失败时令牌身份仍有效，计数诚实降级。
  let projection: ReturnType<typeof readActiveManagedStudioProjection> | undefined;
  try {
    projection = readActiveManagedStudioProjection(shell);
  } catch {
    projection = undefined;
  }

  const tokenBody = contextTokenBody({
    projectId: shell.project.id,
    projectRoot: activeRoot,
    manifestFingerprint: shell.manifestFingerprint,
    activationId: activeState.activationId,
    buildId: identity.buildId,
    sourceDigest: identity.sourceDigest,
  });
  // 二级 nextAction（P2b）：本入口保持物理零写（不开 ledger/dashboard SQLite），
  // 但不再返回占位话术——按活动聚焦给出真实可执行的下一跳，权威值由聚合投影
  // get_studio_production_projection_bundle 按需计算，避免把 N+1 平移进高频入口。
  const activeFocus = activeState.studio?.focus;
  const degradedNextAction: StudioDashboardNextAction = activeFocus?.unitId
    ? {
      code: "read-projection-bundle",
      label: "读取当前单元聚合投影",
      reason: "活动上下文保持物理零写；当前单元的权威 nextAction、逐格 Binding/Review/冻结详情、四轨时间线与相邻摘要由聚合投影一次返回。",
      requiresWrite: false,
      command: "get_studio_production_projection_bundle",
      locator: {
        kind: activeFocus.panelId ? "panel" : "unit",
        projectId: shell.project.id,
        unitId: activeFocus.unitId,
        ...(activeFocus.panelId ? { panelId: activeFocus.panelId } : {}),
      },
    }
    : {
      code: "list-binding-units",
      label: "选择工作单元",
      reason: "活动上下文未记录聚焦单元；先经 get_studio_binding_control(list_units) 选定单元，再用 get_studio_production_projection_bundle 读取该单元的权威下一步。",
      requiresWrite: false,
      command: "get_studio_binding_control",
      locator: { kind: "project", projectId: shell.project.id },
    };
  const body = {
    schemaVersion: ACTIVE_MANAGED_STUDIO_CONTEXT_SCHEMA_VERSION,
    kind: "active-managed-studio-context" as const,
    projectId: shell.project.id,
    projectName: shell.project.name,
    projectRoot: activeRoot,
    manifestFingerprint: shell.manifestFingerprint,
    projectContextToken: `studioctx-v1-${digest(tokenBody)}`,
    build: {
      buildId: identity.buildId,
      sourceDigest: identity.sourceDigest,
      buildAllowed: true as const,
      packageVersion: identity.packageVersion,
    },
    ui: {
      mode: activeState.studio?.mode ?? "canvas" as ActiveStudioMode,
      ...(activeState.studio?.focus ? { focus: activeState.studio.focus } : {}),
      updatedAt: activeState.studio?.updatedAt ?? activeState.updatedAt,
    },
    nextAction: degradedNextAction,
    counts: {
      units: projection?.counts.units ?? 0,
      panels: projection?.counts.panels ?? 0,
      canonicalAssets: projection?.counts.canonicalAssets ?? 0,
      characters: projection?.counts.characters ?? 0,
      scenes: projection?.counts.scenes ?? 0,
      props: projection?.counts.props ?? 0,
      styles: projection?.counts.styles ?? 0,
      media: projection?.counts.media ?? 0,
      bindingSets: projection?.counts.bindingSets ?? 0,
    },
    queueTotals: {
      ambiguity: "bounded-partial" as const,
      missing: "bounded-partial" as const,
      stale: "bounded-partial" as const,
      conflict: "bounded-partial" as const,
      rework: "bounded-partial" as const,
    },
    lockedAssetSample: projection?.lockedAssetSample ?? [],
    agentExecution: {
      executorKind: "agent-imagegen" as const,
      providers: ["codex", "grok"] as const,
      prompt: "managed_studio_lock_generate_writeback" as const,
      writes: "execute_command-only" as const,
    },
    writeLease: {
      held: false,
      expired: false,
      holderId: null as string | null,
      holderKind: null as string | null,
      expiresAt: null as string | null,
      denialHint: null as string | null,
    },
  };
  try {
    const leaseProjection = await getStudioProjectWriteLeaseReadOnly(activeRoot);
    body.writeLease = {
      held: leaseProjection.held,
      expired: leaseProjection.expired,
      holderId: leaseProjection.lease?.holderId ?? null,
      holderKind: leaseProjection.lease?.holderKind ?? null,
      expiresAt: leaseProjection.lease?.expiresAt ?? null,
      denialHint: leaseProjection.denialHint,
    };
  } catch {
    // 租约读取失败不阻断活动工程上下文；写路径仍会在 command-bus 再验。
  }
  return { ...body, fingerprint: digest(body) };
}

export async function assertActiveManagedStudioContextToken(
  projectRoot: string,
  projectContextToken: string,
): Promise<ActiveManagedStudioContext> {
  const context = await getActiveManagedStudioContext();
  if (path.resolve(projectRoot) !== path.resolve(context.projectRoot)
    || projectContextToken !== context.projectContextToken) {
    throw new ActiveManagedStudioContextError(
      "project-context-token-mismatch",
      "活动工程已切换或上下文令牌过期，拒绝跨工程写入。请重新读取活动工程。",
    );
  }
  return context;
}
