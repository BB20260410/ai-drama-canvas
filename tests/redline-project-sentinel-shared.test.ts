import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertRedlineProjectSentinelsUnchanged,
  createIsolatedRedlineProjectCopy,
  normalizeRedlineSentinelMtimeMs,
  snapshotRedlineProjectSentinels,
} from "../scripts/lib/redline-project-sentinel-shared.js";
import { createManagedProject, inspectManagedProject } from "../src/core/managed-project.js";

describe("红线工程 Core 探针隔离", () => {
  it("把平台 mtime 统一归一化为可稳定复核的整数毫秒", () => {
    expect(normalizeRedlineSentinelMtimeMs(1_234.987_654)).toBe(1_234);
  });

  it("完整副本解引用链接，且副本写入不会改动正式哨兵 hash/mtime", async () => {
    const fixtureRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), "redline-sentinel-fixture-")));
    let isolated: Awaited<ReturnType<typeof createIsolatedRedlineProjectCopy>> | undefined;
    try {
      const formalParent = path.join(fixtureRoot, "formal-parent");
      const outside = path.join(fixtureRoot, "outside.txt");
      await mkdir(formalParent, { recursive: true });
      const formal = await createManagedProject({ parentRoot: formalParent, name: "红线隔离测试" });
      const projectRoot = formal.paths.root;
      const sidecar = formal.paths.sidecar;
      await writeFile(outside, "formal-outside\n", "utf8");
      await symlink(outside, path.join(projectRoot, "linked-source.txt"));

      const before = await snapshotRedlineProjectSentinels(projectRoot);
      isolated = await createIsolatedRedlineProjectCopy(projectRoot);
      expect(isolated.projectRoot).not.toBe(projectRoot);
      await expect(inspectManagedProject(isolated.projectRoot)).resolves.toMatchObject({
        project: { id: formal.project.id, primaryRoot: isolated.projectRoot },
      });
      expect(await readFile(path.join(isolated.projectRoot, "linked-source.txt"), "utf8"))
        .toBe("formal-outside\n");
      await writeFile(path.join(isolated.projectRoot, ".aicanvas", "studio-production.sqlite"), "copy-write\n", "utf8");
      await writeFile(path.join(isolated.projectRoot, "linked-source.txt"), "copy-link-write\n", "utf8");

      const after = await assertRedlineProjectSentinelsUnchanged(projectRoot, before);
      expect(after).toEqual(before);
      expect(await readFile(outside, "utf8")).toBe("formal-outside\n");
    } finally {
      await isolated?.cleanup().catch(() => undefined);
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("正式哨兵内容或 mtime 变化都会 fail closed", async () => {
    const fixtureRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), "redline-sentinel-drift-")));
    try {
      const projectRoot = path.join(fixtureRoot, "formal-project");
      const sidecar = path.join(projectRoot, ".aicanvas");
      await mkdir(sidecar, { recursive: true });
      await writeFile(path.join(sidecar, "managed-project.json"), "{}\n", "utf8");
      const before = await snapshotRedlineProjectSentinels(projectRoot);
      await writeFile(path.join(sidecar, "managed-project.json"), "{\"changed\":true}\n", "utf8");
      await expect(assertRedlineProjectSentinelsUnchanged(projectRoot, before)).rejects
        .toThrow(/红线哨兵发生变化/u);
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });
});
