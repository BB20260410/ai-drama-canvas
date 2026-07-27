import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertOnlyStaticPackagedResources,
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
