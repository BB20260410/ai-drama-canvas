import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  assertOnlyStaticPackagedResources,
  assertDirectDependencyVersionIdentity,
  assertElectronBinaryProvenance,
  assertExactDependencyVersionIdentity,
  assertFreshEvidenceTargets,
  assertFreshEvidenceTargetOutsideApp,
  assertBackgroundSmokeEvidence,
  assertPackagedReviewEvidence,
  assertImmutableFileUnchanged,
  assertPathInsidePackageRoot,
  assertTemporaryPackageRoot,
  createIsolatedRuntimeEnvironment,
} from "../scripts/isolated-package-guards.js";

describe("isolated package guards", () => {
  const workspace = path.resolve("/workspace/ai-canvas");
  const packageRoot = path.join(os.tmpdir(), "ai-canvas-current-package-test");

  it("只接受系统临时目录内且位于工作区外的隔离根目录", () => {
    expect(() => assertTemporaryPackageRoot(packageRoot, workspace)).not.toThrow();
    if (process.platform === "darwin") {
      expect(() => assertTemporaryPackageRoot("/private/tmp/ai-canvas-current-package-test", workspace)).not.toThrow();
    }
    expect(() => assertTemporaryPackageRoot(os.tmpdir(), workspace)).toThrow(/子目录/);
    expect(() => assertTemporaryPackageRoot(workspace, workspace)).toThrow(/系统临时目录/);
    expect(() => assertTemporaryPackageRoot(path.join(workspace, "package"), workspace)).toThrow(/系统临时目录/);
  });

  it("拒绝隔离根目录之外的构建产物路径", () => {
    expect(() => assertPathInsidePackageRoot(path.join(packageRoot, "builder-output"), packageRoot, "构建输出")).not.toThrow();
    expect(() => assertPathInsidePackageRoot(packageRoot, packageRoot, "构建输出")).toThrow(/必须位于/);
    expect(() => assertPathInsidePackageRoot(path.join(packageRoot, "..", "escaped"), packageRoot, "构建输出")).toThrow(/必须位于/);
  });

  it("以存在性、字节、mtime 和 SHA-256 共同保护旧 DMG", () => {
    const snapshot = { exists: true, bytes: 1024, mtimeMs: 1234, sha256: "abc" };
    expect(() => assertImmutableFileUnchanged(snapshot, { ...snapshot }, "旧 DMG")).not.toThrow();
    expect(() => assertImmutableFileUnchanged(snapshot, { ...snapshot, mtimeMs: 1235 }, "旧 DMG")).toThrow(/mtimeMs/);
    expect(() => assertImmutableFileUnchanged(snapshot, { ...snapshot, sha256: "def" }, "旧 DMG")).toThrow(/sha256/);
  });

  it("为所有 packaged 子进程建立同一个 fail-closed 运行环境", () => {
    const home = path.join(packageRoot, "home");
    const temporaryDirectory = path.join(packageRoot, "tmp");
    const registryPath = path.join(packageRoot, "runtime", "projects.json");
    const mediaRuntimeDirectory = path.join(packageRoot, "runtime", "media-v1");
    const projectRoot = path.join(packageRoot, "runtime", "project-root");
    const environment = createIsolatedRuntimeEnvironment(
      { PATH: "/usr/bin", HOME: "/Users/real", TMPDIR: "/tmp/real", AI_CANVAS_REGISTRY_PATH: "/Users/real/.aicanvas/projects.json" },
      { packageRoot, home, temporaryDirectory, registryPath, mediaRuntimeDirectory, projectRoot },
    );

    expect(environment).toMatchObject({
      PATH: "/usr/bin",
      HOME: home,
      TMPDIR: temporaryDirectory,
      AI_CANVAS_REGISTRY_PATH: registryPath,
      AI_CANVAS_MEDIA_RUNTIME_DIR: mediaRuntimeDirectory,
      AI_CANVAS_PROJECT_ROOT: projectRoot,
    });
    expect(() => createIsolatedRuntimeEnvironment({}, {
      packageRoot,
      home,
      temporaryDirectory,
      registryPath: "/Users/real/.aicanvas/projects.json",
      mediaRuntimeDirectory,
      projectRoot,
    })).toThrow(/registry.*隔离打包根目录/);
  });

  it("packaged capability 只接受两个静态 Resource URI", () => {
    const expected = ["aicanvas://server/capabilities", "aicanvas://projects"];
    expect(() => assertOnlyStaticPackagedResources(expected)).not.toThrow();
    expect(() => assertOnlyStaticPackagedResources([...expected, "aicanvas://projects/project-secret/tasks"]))
      .toThrow(/动态项目 Resource/);
    expect(() => assertOnlyStaticPackagedResources(["aicanvas://server/capabilities"]))
      .toThrow(/静态 Resource/);
  });

  it("MCP SDK 必须由 package、lock、stage 与 packaged 五方 exact 锁定", () => {
    const valid = {
      dependencyName: "@modelcontextprotocol/sdk",
      packageDirectSpec: "1.30.0",
      lockRootSpec: "1.30.0",
      lockEntryVersion: "1.30.0",
      stageInstalledVersion: "1.30.0",
      packagedInstalledVersion: "1.30.0",
    };
    expect(assertExactDependencyVersionIdentity(valid)).toEqual(valid);
    expect(() => assertExactDependencyVersionIdentity({ ...valid, packageDirectSpec: "^1.30.0" })).toThrow(/exact/u);
    expect(() => assertExactDependencyVersionIdentity({ ...valid, lockRootSpec: "1.29.0" })).toThrow(/五方/u);
    expect(() => assertExactDependencyVersionIdentity({ ...valid, lockEntryVersion: "1.29.0" })).toThrow(/五方/u);
    expect(() => assertExactDependencyVersionIdentity({ ...valid, stageInstalledVersion: "1.29.0" })).toThrow(/五方/u);
    expect(() => assertExactDependencyVersionIdentity({ ...valid, packagedInstalledVersion: "1.29.0" })).toThrow(/五方/u);
  });

  it("所有直接生产依赖必须由 package、lock、stage 与 packaged 共同锁定", () => {
    const valid = {
      dependencyName: "mammoth",
      packageDirectSpec: "^1.12.0",
      lockRootSpec: "^1.12.0",
      lockEntryVersion: "1.12.0",
      stageInstalledVersion: "1.12.0",
      packagedInstalledVersion: "1.12.0",
    };
    expect(assertDirectDependencyVersionIdentity(valid)).toEqual(valid);
    expect(() => assertDirectDependencyVersionIdentity({ ...valid, lockRootSpec: "1.12.0" })).toThrow(/package.*lock root/u);
    expect(() => assertDirectDependencyVersionIdentity({ ...valid, stageInstalledVersion: "1.11.0" })).toThrow(/lock.*stage.*packaged/u);
    expect(() => assertDirectDependencyVersionIdentity({ ...valid, packagedInstalledVersion: "1.11.0" })).toThrow(/lock.*stage.*packaged/u);
  });

  it("隔离打包从 lockfile 安装依赖且不复制工作区 node_modules", async () => {
    const smoke = await readFile(path.join(process.cwd(), "scripts/isolated-package-smoke.ts"), "utf8");
    expect(smoke).toContain('"isolated lockfile-faithful npm ci"');
    expect(smoke).toContain('"--registry=https://registry.npmjs.org"');
    expect(smoke).toContain("directProductionDependencyIdentities");
    expect(smoke).toContain('"isolated lockfile Electron binary install"');
    expect(smoke).toContain("install-electron");
    expect(smoke).toContain("assertElectronBinaryProvenance");
    expect(smoke).toContain('"repack lockfile Electron distribution"');
    expect(smoke).toContain('"--keepParent"');
    expect(smoke).toContain("isolatedPackageCompletionMarkerPath(evidencePath)");
    expect(smoke).toContain("finalizeIsolatedPackageTerminalEvidence({");
    expect(smoke).toContain("lockPath: evidenceRunLock.path");
    expect(smoke).toContain('outcome: runError ? "failed" : "passed"');
    expect(smoke).not.toMatch(/stageInputs[\s\S]{0,400}"node_modules"/u);
    expect(smoke).not.toContain("await evidenceRunLock.release();\nawait writeJsonAtomicExclusive(evidencePath");
    const baselineEnd = smoke.indexOf("workspaceMcpManifestBefore = await fileManifest");
    const lockAcquire = smoke.indexOf("await acquireEvidenceRunLock(");
    expect(baselineEnd).toBeGreaterThan(-1);
    expect(lockAcquire).toBeGreaterThan(baselineEnd);
    expect(smoke).toContain("collectIsolatedPackagePostCleanupEvidence");
    expect(smoke).toContain("postCleanupError");
    expect(smoke.indexOf("collectIsolatedPackagePostCleanupEvidence")).toBeLessThan(
      smoke.indexOf("finalizeIsolatedPackageTerminalEvidence({"),
    );
  });

  it("Electron binary 必须来自同一 lock 身份且具有 arm64 可执行体与标准 ZIP 布局", () => {
    const valid = {
      packageDirectSpec: "43.1.0",
      lockEntryVersion: "43.1.0",
      installedPackageVersion: "43.1.0",
      distVersion: "43.1.0",
      executableRelativePath: "Electron.app/Contents/MacOS/Electron",
      executableBytes: 33_968,
      executableMode: 0o100755,
      architectures: ["arm64"],
      archiveName: "electron-v43.1.0-darwin-arm64.zip",
      archiveBytes: 120_000_000,
      archiveEntries: [
        "Electron.app/",
        "Electron.app/Contents/",
        "Electron.app/Contents/MacOS/Electron",
      ],
    };
    expect(assertElectronBinaryProvenance(valid)).toEqual(valid);
    expect(() => assertElectronBinaryProvenance({ ...valid, installedPackageVersion: "43.0.0" }))
      .toThrow(/版本身份/u);
    expect(() => assertElectronBinaryProvenance({ ...valid, architectures: ["x86_64"] }))
      .toThrow(/arm64/u);
    expect(() => assertElectronBinaryProvenance({ ...valid, executableMode: 0o100644 }))
      .toThrow(/可执行/u);
    expect(() => assertElectronBinaryProvenance({ ...valid, archiveEntries: ["Electron.app/"] }))
      .toThrow(/ZIP/u);
  });

  it("安装版验收脚本自身强制后台模式并使用有界关闭证据", async () => {
    const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const verifier = await readFile(path.join(workspace, "scripts/verify-p14-installed-app.ts"), "utf8");
    expect(verifier).toContain('AI_CANVAS_ELECTRON_BACKGROUND_SMOKE: "1"');
    expect(verifier).toContain("captureBackgroundElectronStateOrThrow");
    expect(verifier).toContain("closeElectronApplicationOrThrow");
    expect(verifier).toContain("assertFreshEvidenceTargetOutsideApp");
    expect(verifier).not.toContain("await application.close()");
  });

  it("安装验收证据拒绝 App 内路径、symlink parent 与非 ENOENT 路径错误", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "aic-installed-evidence-boundary-"));
    const appPath = path.join(root, "AI Canvas.app");
    const resources = path.join(appPath, "Contents", "Resources");
    const outside = path.join(root, "evidence", "result.json");
    const linkedParent = path.join(root, "linked-resources");
    const loopParent = path.join(root, "loop-parent");
    await mkdir(resources, { recursive: true });
    await symlink(resources, linkedParent);
    await symlink("loop-parent", loopParent);
    try {
      await expect(assertFreshEvidenceTargetOutsideApp({
        appPath,
        evidencePath: path.join(resources, "result.json"),
      })).rejects.toThrow(/App 内部/u);
      await expect(assertFreshEvidenceTargetOutsideApp({
        appPath,
        evidencePath: path.join(linkedParent, "result.json"),
      })).rejects.toThrow(/App 内部/u);
      await expect(assertFreshEvidenceTargetOutsideApp({ appPath, evidencePath: outside }))
        .resolves.toMatchObject({
          canonicalAppPath: await realpath(appPath),
          canonicalEvidencePath: path.join(await realpath(root), "evidence", "result.json"),
        });
      await expect(assertFreshEvidenceTargetOutsideApp({
        appPath,
        evidencePath: path.join(loopParent, "result.json"),
      })).rejects.toMatchObject({ code: "ELOOP" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("隔离 UI 证据必须证明四个观察点从未展示、聚焦或占用 Dock", () => {
    const snapshot = {
      enabled: true,
      platform: "darwin",
      activationPolicy: "accessory",
      dockVisible: false,
      focusedWindowId: null,
      windows: [{ id: 1, showEvents: 0, focusEvents: 0, readyToShowEvents: 1, visible: false, focused: false, destroyed: false }],
    };
    const valid = {
      enabled: true,
      bringToFrontUsed: false,
      snapshots: ["first-ready", "first-close", "restart-ready", "restart-close"]
        .map((label) => ({ label, ...snapshot })),
    };

    expect(() => assertBackgroundSmokeEvidence(valid, "Effect")).not.toThrow();
    expect(() => assertBackgroundSmokeEvidence({
      ...valid,
      snapshots: valid.snapshots.map((entry, index) => index === 2
        ? { ...entry, windows: [{ ...entry.windows[0], showEvents: 1 }] }
        : entry),
    }, "Effect")).toThrow(/showEvents/u);
  });

  it("证据目标只接受全新且互不重复的路径，既存 PASS 不得被本轮覆盖或删除", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "aic-evidence-targets-"));
    const existing = path.join(root, "existing.json");
    const fresh = path.join(root, "fresh.json");
    const oldPass = '{"status":"passed","generatedAt":"old"}\n';
    await mkdir(root, { recursive: true });
    await writeFile(existing, oldPass, "utf8");
    try {
      await expect(assertFreshEvidenceTargets([
        { label: "顶层证据", path: existing },
        { label: "截图", path: fresh },
      ])).rejects.toThrow(/拒绝覆盖.*顶层证据/u);
      expect(await readFile(existing, "utf8")).toBe(oldPass);
      await expect(assertFreshEvidenceTargets([
        { label: "顶层证据", path: fresh },
        { label: "重复目标", path: path.join(root, ".", "fresh.json") },
      ])).rejects.toThrow(/重复/u);
      await expect(assertFreshEvidenceTargets([
        { label: "顶层证据", path: fresh },
        { label: "截图", path: path.join(root, "fresh.png") },
      ])).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("packaged ReviewStudio 证据必须证明 stale-submit、完整重启和清理", () => {
    const executablePath = path.join(packageRoot, "AI 漫剧画布.app", "Contents", "MacOS", "AI 漫剧画布");
    const screenshotPath = path.join("/workspace", "review-packaged.png");
    const valid = {
      status: "passed",
      transport: "packaged-electron-current-source",
      executablePath,
      pageErrors: [],
      assertions: {
        staleSubmitRejectedThroughUi: true,
        staleAttemptWroteNoReview: true,
        staleRejectAutoReloadedHash: true,
        staleRejectResetCriteria: true,
        visualPassSubmittedThroughUi: true,
        passRestoredAfterApplicationRestart: true,
        restartHashMatchesPassedContent: true,
        statusReturnedToVisualReview: true,
        historyPreserved: true,
      },
      screenshot: { path: screenshotPath, bytes: 20_001, width: 1560, height: 980 },
      terminal: { rootRemoved: true, registryRemoved: true, userDataRemoved: true },
    };

    expect(() => assertPackagedReviewEvidence(valid, { executablePath, screenshotPath })).not.toThrow();
    expect(() => assertPackagedReviewEvidence({ ...valid, transport: "source-electron-current-build" }, { executablePath, screenshotPath })).toThrow(/transport/);
    expect(() => assertPackagedReviewEvidence({ ...valid, assertions: { ...valid.assertions, passRestoredAfterApplicationRestart: false } }, { executablePath, screenshotPath })).toThrow(/passRestoredAfterApplicationRestart/);
    expect(() => assertPackagedReviewEvidence({ ...valid, terminal: { ...valid.terminal, userDataRemoved: false } }, { executablePath, screenshotPath })).toThrow(/userDataRemoved/);
  });
});
