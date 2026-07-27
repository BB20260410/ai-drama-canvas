import { link, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertOwnedTemporaryFixtureRoot,
  createOwnedFixtureRootAt,
  mkdtempOwnedFixtureRoot,
  OWNED_FIXTURE_MARKER_NAME,
  removeOwnedTemporaryFixtureRoot,
  resetOwnedFixtureRoot,
} from "../scripts/lib/owned-fixture-root.js";

const cleanup: string[] = [];
const previousRegistryPath = process.env.AI_CANVAS_REGISTRY_PATH;
afterEach(async () => {
  if (previousRegistryPath === undefined) delete process.env.AI_CANVAS_REGISTRY_PATH;
  else process.env.AI_CANVAS_REGISTRY_PATH = previousRegistryPath;
  await Promise.all(cleanup.splice(0).map((entry) => rm(entry, { recursive: true, force: true })));
});

describe("脚本自有夹具根安全清理", () => {
  it("owner marker 和 inode 一致时才允许重置", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "owned-fixture-reset-"));
    cleanup.push(parent);
    const root = path.join(parent, "fixture");
    await createOwnedFixtureRootAt(root, "fixture-reset-test");
    await writeFile(path.join(root, "payload.txt"), "old");

    await resetOwnedFixtureRoot(root, "fixture-reset-test");
    expect((await readdir(root)).sort()).toEqual([OWNED_FIXTURE_MARKER_NAME]);
    expect(JSON.parse(await readFile(path.join(root, OWNED_FIXTURE_MARKER_NAME), "utf8")))
      .toMatchObject({ schemaVersion: 1, kind: "aicanvas-owned-temporary-fixture-root", ownerId: "fixture-reset-test" });
  });

  it("既有无 marker 目录无论空或非空均不被接管，helper 自分配根可安全使用", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "owned-fixture-unowned-"));
    cleanup.push(parent);
    const occupied = path.join(parent, "occupied");
    await mkdir(occupied);
    await writeFile(path.join(occupied, "keep.txt"), "keep");
    await expect(resetOwnedFixtureRoot(occupied, "fixture-unowned-test")).rejects.toThrow("owner marker");
    expect(await readFile(path.join(occupied, "keep.txt"), "utf8")).toBe("keep");

    const empty = await mkdtemp(path.join(os.tmpdir(), "owned-fixture-empty-"));
    cleanup.push(empty);
    await expect(resetOwnedFixtureRoot(empty, "fixture-empty-test")).rejects.toThrow();
    expect(await readdir(empty)).toEqual([]);

    const allocated = await mkdtempOwnedFixtureRoot("owned-fixture-allocated", "fixture-allocated-test");
    cleanup.push(allocated.root);
    expect(await readdir(allocated.root)).toEqual([OWNED_FIXTURE_MARKER_NAME]);
    expect(await assertOwnedTemporaryFixtureRoot(allocated.root, "fixture-allocated-test"))
      .toMatchObject({ root: allocated.root, leaseId: allocated.leaseId, dev: allocated.dev, ino: allocated.ino });
    await removeOwnedTemporaryFixtureRoot(allocated.root, "fixture-allocated-test");
    cleanup.splice(cleanup.indexOf(allocated.root), 1);
  });

  it("symlink 和高风险根在递归删除前失败关闭", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "owned-fixture-symlink-"));
    cleanup.push(parent);
    const outside = path.join(parent, "outside");
    await mkdir(outside);
    await writeFile(path.join(outside, "keep.txt"), "keep");
    const linked = path.join(parent, "linked");
    await symlink(outside, linked, "dir");

    await expect(resetOwnedFixtureRoot(linked, "fixture-symlink-test")).rejects.toThrow("符号链接");
    expect(await readFile(path.join(outside, "keep.txt"), "utf8")).toBe("keep");
    await expect(resetOwnedFixtureRoot(os.tmpdir(), "fixture-root-test")).rejects.toThrow("专用子目录");
    await expect(resetOwnedFixtureRoot(process.cwd(), "fixture-workspace-test")).rejects.toThrow("系统临时目录");
  });

  it("拒绝活动工程及其父子路径，并校验 marker 单链接和 inode", async () => {
    const runtime = await mkdtemp(path.join(os.tmpdir(), "owned-fixture-active-"));
    cleanup.push(runtime);
    const registry = path.join(runtime, "registry", "projects.json");
    const activeProject = path.join(runtime, "active-project");
    await mkdir(path.dirname(registry));
    await mkdir(activeProject);
    await writeFile(registry, `${JSON.stringify([{ id: "project-fixture", name: "fixture", primaryRoot: activeProject, updatedAt: new Date().toISOString() }])}\n`);
    await writeFile(path.join(path.dirname(registry), "active-project.json"), `${JSON.stringify({ schemaVersion: 2, primaryRoot: activeProject, activationId: "12345678-1234-1234-1234-123456789abc", activatedAt: new Date().toISOString(), updatedAt: new Date().toISOString() })}\n`);
    process.env.AI_CANVAS_REGISTRY_PATH = registry;

    await expect(createOwnedFixtureRootAt(path.join(activeProject, "child"), "fixture-active-child")).rejects.toThrow("受保护路径");
    await expect(resetOwnedFixtureRoot(runtime, "fixture-active-parent")).rejects.toThrow();

    const root = path.join(runtime, "owned");
    await createOwnedFixtureRootAt(root, "fixture-marker-test");
    const markerPath = path.join(root, OWNED_FIXTURE_MARKER_NAME);
    const hardlinkPath = path.join(root, "marker-hardlink.json");
    await link(markerPath, hardlinkPath);
    await expect(assertOwnedTemporaryFixtureRoot(root, "fixture-marker-test")).rejects.toThrow("owner marker");
    await rm(hardlinkPath);
    const marker = JSON.parse(await readFile(markerPath, "utf8")) as Record<string, unknown>;
    marker.rootIno = "0";
    await writeFile(markerPath, `${JSON.stringify(marker)}\n`);
    await expect(assertOwnedTemporaryFixtureRoot(root, "fixture-marker-test")).rejects.toThrow("inode");
  });
});
