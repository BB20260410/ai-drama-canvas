import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createManagedProject,
} from "../src/core/managed-project.js";
import {
  discoverDuduReadonlyImportProjects,
  getDuduReadonlyImportControl,
} from "../src/core/dudu-readonly-import.js";

const roots: string[] = [];
const originalRegistryPath = process.env.AI_CANVAS_REGISTRY_PATH;

afterEach(async () => {
  if (originalRegistryPath === undefined) delete process.env.AI_CANVAS_REGISTRY_PATH;
  else process.env.AI_CANVAS_REGISTRY_PATH = originalRegistryPath;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function treeSnapshot(root: string): Promise<Record<string, unknown>> {
  const output: Record<string, unknown> = {};
  const walk = async (current: string): Promise<void> => {
    const names = (await readdir(current)).sort((left, right) => left.localeCompare(right, "en"));
    for (const name of names) {
      const absolute = path.join(current, name);
      const relative = path.relative(root, absolute);
      const metadata = await lstat(absolute, { bigint: true });
      output[relative] = {
        kind: metadata.isDirectory() ? "directory" : metadata.isFile() ? "file" : "other",
        size: metadata.size.toString(),
        mtimeNs: metadata.mtimeNs.toString(),
        ...(metadata.isFile()
          ? { sha256: createHash("sha256").update(await readFile(absolute)).digest("hex") }
          : {}),
      };
      if (metadata.isDirectory()) await walk(absolute);
    }
  };
  await walk(root);
  return output;
}

describe.sequential("P30 Dudu staging 只读发现", () => {
  it("保存根尚不存在时返回空候选，不创建目录也不暴露 ENOENT", async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "p30-dudu-discovery-missing-")));
    roots.push(root);
    const projectsRoot = path.join(root, "尚未建立的项目根");

    await expect(lstat(projectsRoot)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(discoverDuduReadonlyImportProjects(projectsRoot)).resolves.toMatchObject({
      projectsRoot,
      status: "none",
      candidateCount: 0,
      nextAction: "stage-new-via-authorized-core-orchestration",
      readOnly: true,
    });
    await expect(lstat(projectsRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("返回 0/1/冲突三态，忽略非 Dudu claim，且扫描本身不写工程", async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "p30-dudu-discovery-")));
    roots.push(root);
    const stateRoot = path.join(root, "state");
    const projectsRoot = (await createManagedProject({
      parentRoot: root,
      name: "占位父工程",
      slug: "projects",
    })).paths.root;
    process.env.AI_CANVAS_REGISTRY_PATH = path.join(stateRoot, "projects.json");

    await expect(discoverDuduReadonlyImportProjects(projectsRoot)).resolves.toMatchObject({
      status: "none",
      candidateCount: 0,
      nextAction: "stage-new-via-authorized-core-orchestration",
      readOnly: true,
    });

    await createManagedProject({ parentRoot: projectsRoot, name: "普通受管工程", slug: "ordinary" });
    const first = await createManagedProject({
      parentRoot: projectsRoot,
      name: "Dudu staging A",
      slug: "dudu-s1e1",
      bootstrapClaim: { purpose: "dudu-readonly-import", payload: { fixture: "a" } },
    });
    const before = await treeSnapshot(projectsRoot);
    const single = await discoverDuduReadonlyImportProjects(projectsRoot);
    const after = await treeSnapshot(projectsRoot);
    expect(after).toEqual(before);
    expect(single).toMatchObject({
      status: "single",
      candidateCount: 1,
      candidates: [{
        projectRoot: first.paths.root,
        projectId: first.project.id,
        controlStatus: "staging-incomplete",
        control: { status: "staging-incomplete", readOnly: true },
      }],
      nextAction: "inspect-single-staging",
    });

    await mkdir(stateRoot, { recursive: true });
    const activePath = path.join(stateRoot, "active-project.json");
    const now = new Date().toISOString();
    await writeFile(activePath, `${JSON.stringify({
      schemaVersion: 2,
      primaryRoot: first.paths.root,
      activationId: "a".repeat(32),
      activatedAt: now,
      updatedAt: now,
    })}\n`);
    await expect(getDuduReadonlyImportControl(first.paths.root)).rejects.toThrow(
      "活动指针已命中，但 import/registration/registry 身份链未闭合",
    );
    await unlink(activePath);

    await createManagedProject({
      parentRoot: projectsRoot,
      name: "Dudu staging B",
      slug: "dudu-s1e1",
      bootstrapClaim: { purpose: "dudu-readonly-import", payload: { fixture: "b" } },
    });
    const conflict = await discoverDuduReadonlyImportProjects(projectsRoot);
    expect(conflict).toMatchObject({
      status: "conflict",
      candidateCount: 2,
      nextAction: "resolve-staging-conflict",
    });
    expect(conflict.candidates).toHaveLength(2);
    expect(conflict).not.toHaveProperty("selected");
    expect(conflict).not.toHaveProperty("selectedProjectRoot");
  });
});
