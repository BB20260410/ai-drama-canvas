import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertActiveManagedStudioContextToken,
  createSharedAsyncSingleFlight,
  failSoftAfter,
  getActiveManagedStudioContext,
  resolveAiCanvasWorkspaceRoot,
} from "../src/core/active-managed-studio-context.js";
import { createBuildIdentity } from "../src/core/build-identity.js";
import {
  AI_CANVAS_APPLICATION_VERSION,
  AI_CANVAS_PROTOCOL_VERSION,
  RELEASE_MANIFEST_SCHEMA_VERSION,
  releaseManifestDigest,
  type ReleaseManifest,
} from "../src/core/release-manifest.js";
import { createManagedProject } from "../src/core/managed-project.js";
import {
  getActiveProjectState,
  registerProject,
  setActiveProjectRegistration,
  setActiveStudioContext,
} from "../src/core/sidecar.js";

const roots: string[] = [];
const originalRegistry = process.env.AI_CANVAS_REGISTRY_PATH;
const originalWorkspace = process.env.AI_CANVAS_WORKSPACE;
const originalRecordedDigest = process.env.AI_CANVAS_RECORDED_SOURCE_DIGEST;
const originalReleaseManifestPath = process.env.AI_CANVAS_RELEASE_MANIFEST_PATH;

afterEach(async () => {
  vi.useRealTimers();
  if (originalRegistry === undefined) delete process.env.AI_CANVAS_REGISTRY_PATH;
  else process.env.AI_CANVAS_REGISTRY_PATH = originalRegistry;
  if (originalWorkspace === undefined) delete process.env.AI_CANVAS_WORKSPACE;
  else process.env.AI_CANVAS_WORKSPACE = originalWorkspace;
  if (originalRecordedDigest === undefined) delete process.env.AI_CANVAS_RECORDED_SOURCE_DIGEST;
  else process.env.AI_CANVAS_RECORDED_SOURCE_DIGEST = originalRecordedDigest;
  if (originalReleaseManifestPath === undefined) delete process.env.AI_CANVAS_RELEASE_MANIFEST_PATH;
  else process.env.AI_CANVAS_RELEASE_MANIFEST_PATH = originalReleaseManifestPath;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const parent = await realpath(await mkdtemp(path.join(os.tmpdir(), "ai-canvas-active-context-")));
  roots.push(parent);
  process.env.AI_CANVAS_REGISTRY_PATH = path.join(parent, "registry", "projects.json");
  process.env.AI_CANVAS_WORKSPACE = process.cwd();
  delete process.env.AI_CANVAS_RECORDED_SOURCE_DIGEST;
  const first = await createManagedProject({ parentRoot: parent, name: "第一受管工程", slug: "first" });
  const second = await createManagedProject({ parentRoot: parent, name: "第二受管工程", slug: "second" });
  await registerProject(first.project);
  await registerProject(second.project);
  return { first, second };
}

describe("活动受管 Studio 上下文", () => {
  it("fail-soft 后复用尚未结束的慢投影，真正结算前不重复启动底层读取", async () => {
    vi.useFakeTimers();
    let resolveProjection: ((value: string) => void) | undefined;
    let starts = 0;
    const shared = createSharedAsyncSingleFlight(async (projectRoot: string) => {
      starts += 1;
      return new Promise<string>((resolve) => {
        resolveProjection = resolve;
      });
    });

    const first = failSoftAfter(shared("/project-a"), 30, "慢 dashboard");
    const firstExpectation = expect(first).rejects.toThrow("慢 dashboard 超过 30ms");
    await vi.advanceTimersByTimeAsync(30);
    await firstExpectation;
    expect(starts).toBe(1);

    const second = failSoftAfter(shared("/project-a"), 100, "慢 dashboard");
    await vi.advanceTimersByTimeAsync(40);
    expect(starts).toBe(1);
    resolveProjection?.("projection-ready");
    await vi.advanceTimersByTimeAsync(0);
    await expect(second).resolves.toBe("projection-ready");

    const third = shared("/project-a");
    await vi.advanceTimersByTimeAsync(0);
    expect(starts).toBe(2);
    resolveProjection?.("projection-refreshed");
    await expect(third).resolves.toBe("projection-refreshed");
  });

  it("只读取明确活动工程并保留桌面焦点，不受注册表顺序影响", async () => {
    const { first, second } = await fixture();
    await setActiveProjectRegistration(first.paths.root);
    await setActiveStudioContext(first.paths.root, {
      mode: "binding",
      focus: { unitId: "unit-001", panelId: "panel-01", assetId: "character-ahang" },
    });

    const context = await getActiveManagedStudioContext();
    expect(context).toMatchObject({
      projectId: first.project.id,
      projectRoot: first.paths.root,
      ui: {
        mode: "binding",
        focus: { unitId: "unit-001", panelId: "panel-01", assetId: "character-ahang" },
      },
      agentExecution: { providers: ["codex", "grok"], writes: "execute_command-only" },
    });
    expect(context.projectId).not.toBe(second.project.id);
    expect(context.projectContextToken).toMatch(/^studioctx-v1-[a-f0-9]{64}$/u);
    await expect(assertActiveManagedStudioContextToken(first.paths.root, context.projectContextToken))
      .resolves.toMatchObject({ projectId: first.project.id });
  }, 120_000);

  it("切换工程后旧 token 失效，焦点更新本身不改变 activation token", async () => {
    const { first, second } = await fixture();
    await setActiveProjectRegistration(first.paths.root);
    const before = await getActiveManagedStudioContext();
    await setActiveStudioContext(first.paths.root, { mode: "dashboard", focus: { unitId: "unit-a" } });
    const afterFocus = await getActiveManagedStudioContext();
    expect(afterFocus.projectContextToken).toBe(before.projectContextToken);

    await setActiveProjectRegistration(second.paths.root);
    const state = await getActiveProjectState();
    expect(state?.primaryRoot).toBe(second.paths.root);
    await expect(assertActiveManagedStudioContextToken(first.paths.root, before.projectContextToken))
      .rejects.toThrow("活动工程已切换");
  }, 120_000);

  it("没有活动指针时失败关闭，绝不偷选已登记的第一项", async () => {
    const { first } = await fixture();
    await rm(path.join(path.dirname(process.env.AI_CANVAS_REGISTRY_PATH!), "active-project.json"), { force: true });
    expect(first.project.id).toBeTruthy();
    await expect(getActiveManagedStudioContext()).rejects.toThrow("尚未选择活动工程");
  });

  it("安装态从 release manifest 定位身份根，不要求包内存在源码 package.json", async () => {
    const resourcesRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), "ai-canvas-installed-resources-")));
    roots.push(resourcesRoot);
    const identity = await createBuildIdentity(process.cwd());
    const body: Omit<ReleaseManifest, "fingerprint"> = {
      schemaVersion: RELEASE_MANIFEST_SCHEMA_VERSION,
      kind: "ai-drama-canvas-release-manifest",
      version: AI_CANVAS_APPLICATION_VERSION,
      architecture: process.arch,
      sourceDigest: identity.sourceDigest,
      buildId: identity.buildId,
      buildIdentityFingerprint: identity.fingerprint,
      protocolVersion: AI_CANVAS_PROTOCOL_VERSION,
      mcpToolCount: identity.capabilities.mcpToolCount,
      builtAt: new Date().toISOString(),
      distribution: "local-only",
      localOnly: true,
      source: { files: identity.roots.sourceFiles, bytes: identity.roots.sourceBytes },
    };
    const manifest: ReleaseManifest = { ...body, fingerprint: releaseManifestDigest(body) };
    const manifestPath = path.join(resourcesRoot, "release-manifest.json");
    await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`, "utf8");
    process.env.AI_CANVAS_RELEASE_MANIFEST_PATH = manifestPath;
    process.env.AI_CANVAS_WORKSPACE = path.join(resourcesRoot, "missing-source-tree");
    await expect(resolveAiCanvasWorkspaceRoot()).resolves.toBe(resourcesRoot);
  }, 120_000);
});
