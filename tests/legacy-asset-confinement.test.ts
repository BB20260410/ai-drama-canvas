import { mkdtemp, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  collectLegacyAssetAllowedRoots,
  isLegacyUnhashedMediaPathAllowed,
  isLegacyAssetPathAllowed,
  isPathInsideRoots,
  readLegacyAssetBytes,
  resetLegacyAssetConfinementCacheForTests,
} from "../src/core/legacy-asset-confinement.js";

/** P27 F-01：aicanvas-asset 协议根限制定向测试。 */

const roots: string[] = [];

afterEach(async () => {
  resetLegacyAssetConfinementCacheForTests();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

describe("legacy-asset-confinement", () => {
  it("isPathInsideRoots：根内/根自身/前缀边界/根外", () => {
    const roots = ["/a/project", "/b/out"];
    expect(isPathInsideRoots("/a/project", roots)).toBe(true);
    expect(isPathInsideRoots("/a/project/media/x.png", roots)).toBe(true);
    expect(isPathInsideRoots("/b/out/render/final.mp4", roots)).toBe(true);
    expect(isPathInsideRoots("/a/project-evil/x.png", roots)).toBe(false);
    expect(isPathInsideRoots("/a", roots)).toBe(false);
    expect(isPathInsideRoots("/etc/hosts", roots)).toBe(false);
    // 注：纯函数契约要求输入已 realpath 归一化（含 .. 解析）；归一化由 isLegacyAssetPathAllowed 负责。
    expect(isPathInsideRoots("", [])).toBe(false);
    expect(isLegacyUnhashedMediaPathAllowed("/tmp/frame.PNG")).toBe(true);
    expect(isLegacyUnhashedMediaPathAllowed("/tmp/cache.sqlite")).toBe(false);
  });

  it("isLegacyAssetPathAllowed：无登记工程时一律拒绝；登记后放行工程内、拒绝工程外与不存在路径", async () => {
    const outside = await tempRoot("p27-outside-");
    const fileOutside = path.join(outside, "x.png");
    await import("node:fs/promises").then((fs) => fs.writeFile(fileOutside, "png"));
    // 无登记工程（默认注册表未必为空，但临时路径绝不在任何工程内）→ 拒绝。
    expect(await isLegacyAssetPathAllowed(fileOutside)).toBe(false);
    expect(await isLegacyAssetPathAllowed(path.join(outside, "no-such.png"))).toBe(false);

    // 登记一个工程（含 sourceRoots/outputRoots）→ 工程内放行。
    const parent = await import("node:fs/promises").then(async (fs) => fs.realpath(await tempRoot("p27-project-")));
    const { createManagedProject } = await import("../src/core/managed-project.js");
    const { registerProject } = await import("../src/core/sidecar.js");
    const { inspectManagedProject } = await import("../src/core/managed-project.js");
    const shell = await createManagedProject({ parentRoot: parent, name: "P27 根限制" });
    const projectRoot = shell.paths.root;
    await registerProject((await inspectManagedProject(projectRoot)).project);
    resetLegacyAssetConfinementCacheForTests();

    const insideDir = path.join(projectRoot, "media");
    await import("node:fs/promises").then((fs) => fs.mkdir(insideDir, { recursive: true }));
    const insideFile = path.join(insideDir, "ok.png");
    await import("node:fs/promises").then((fs) => fs.writeFile(insideFile, "png"));
    expect(await isLegacyAssetPathAllowed(insideFile)).toBe(true);

    const rootsList = await collectLegacyAssetAllowedRoots();
    expect(rootsList.some((root) => insideFile.startsWith(`${root}${path.sep}`))).toBe(true);

    const alias = path.join(projectRoot, "media", "alias.png");
    await symlink(fileOutside, alias);
    expect(await isLegacyAssetPathAllowed(alias)).toBe(false);
    expect(await readLegacyAssetBytes(alias)).toBeNull();

    // 注销后不依赖 5s TTL 或测试清缓存：注册表修订号必须立即让白名单缓存失效。
    const { unregisterProject } = await import("../src/core/sidecar.js");
    await unregisterProject(projectRoot);
    expect(await isLegacyAssetPathAllowed(insideFile)).toBe(false);
  });
});
