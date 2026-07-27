import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  finalizeDuduReadonlyManagedProject,
  getDuduReadonlyImportControl,
  stageDuduReadonlyManagedProject,
} from "../src/core/dudu-readonly-import.js";
import { createManagedProject } from "../src/core/managed-project.js";
import { activateProject } from "../src/core/service.js";
import {
  getActiveProjectStateReadOnly,
  listRegisteredProjects,
  registerProject,
} from "../src/core/sidecar.js";
import {
  createStudioGenerationPlan,
  readStudioUnitGridGenerationFrozenPack,
} from "../src/core/studio-generation-ledger.js";
import {
  createDuduReadonlySourceFixture,
  type DuduReadonlySourceFixture,
} from "./helpers/dudu-readonly-source-fixture.js";

const REGISTRATION_RELATIVE_PATH = ".aicanvas/dudu-readonly-registration.json";
const IMPORT_RELATIVE_PATH = ".aicanvas/dudu-readonly-import.json";
const ACTIVATION_RELATIVE_ROOT = ".aicanvas/dudu-readonly-activations";

async function withFixtureRegistry<T>(
  fixture: DuduReadonlySourceFixture,
  run: () => Promise<T>,
): Promise<T> {
  const prior = process.env.AI_CANVAS_REGISTRY_PATH;
  process.env.AI_CANVAS_REGISTRY_PATH = fixture.registryPath;
  try {
    return await run();
  } finally {
    if (prior === undefined) delete process.env.AI_CANVAS_REGISTRY_PATH;
    else process.env.AI_CANVAS_REGISTRY_PATH = prior;
  }
}

async function expectMissing(filePath: string): Promise<void> {
  await expect(readFile(filePath)).rejects.toMatchObject({ code: "ENOENT" });
}

describe.sequential("P30 Dudu post-registration activation receipt 恢复", () => {
  it("正式 generation 演进后只补当前 activation receipt，并对 source/import/registration/registry/active 冲突失败关闭", async () => {
    const fixture = await createDuduReadonlySourceFixture();
    try {
      await withFixtureRegistry(fixture, async () => {
        const staged = await stageDuduReadonlyManagedProject({
          projectsRoot: fixture.projectsRoot,
          source: fixture.source,
        });
        const projectRoot = staged.shell.paths.root;
        const firstFinalization = await finalizeDuduReadonlyManagedProject(projectRoot, fixture.source);
        const firstActivationPath = path.join(
          projectRoot,
          ACTIVATION_RELATIVE_ROOT,
          `${firstFinalization.activationId}.json`,
        );
        const firstActivationBytes = await readFile(firstActivationPath);

        // 只追加一条由 generation owner 正常接受的正式计划，模拟 U29 式生产账本已经演进；
        // 不派发、不调用模型、不登记候选、不写媒体。
        const u29 = staged.receipt.units.find((unit) => unit.unitId === "S1E01-U29")!;
        const pack = await readStudioUnitGridGenerationFrozenPack(projectRoot, u29.packId!);
        expect(pack).not.toBeNull();
        await createStudioGenerationPlan(projectRoot, {
          nodes: [{ targetKind: "unit-grid", unitId: "S1E01-U29" }],
          sourceCommandRequestId: "p30-reactivation-recovery-u29-plan-1",
        });

        const other = await createManagedProject({
          parentRoot: fixture.projectsRoot,
          name: "P30 activation switch fixture",
          slug: "p30-activation-switch-fixture",
        });
        await registerProject(other.project);

        // 已有动态 generation 的注册 owner 不允许 finalize 隐式把活动指针从别的工程切回来。
        await activateProject(other.paths.root);
        await expect(finalizeDuduReadonlyManagedProject(projectRoot, fixture.source))
          .rejects.toThrow(/当前活动指针已精确命中/u);
        expect((await getActiveProjectStateReadOnly())?.primaryRoot).toBe(other.paths.root);

        // 用户/桌面端明确重新激活 Dudu，产生新的 activationId；此时 receipt 尚不存在。
        await activateProject(projectRoot);
        const reactivated = await getActiveProjectStateReadOnly();
        expect(reactivated?.primaryRoot).toBe(projectRoot);
        expect(reactivated?.activationId).not.toBe(firstFinalization.activationId);
        const currentActivationPath = path.join(
          projectRoot,
          ACTIVATION_RELATIVE_ROOT,
          `${reactivated!.activationId}.json`,
        );
        await expectMissing(currentActivationPath);
        await expect(getDuduReadonlyImportControl(projectRoot)).resolves.toMatchObject({
          status: "activation-incomplete",
          blockers: ["activation-receipt-missing"],
        });

        // 请求 source 选择器即便内容相同，只要身份路径不同也不得补 receipt。
        const alternateLockedScript = path.join(fixture.root, "alternate-source", "locked-script.md");
        await mkdir(path.dirname(alternateLockedScript), { recursive: true });
        await writeFile(alternateLockedScript, await readFile(fixture.source.lockedScriptPath));
        await expect(finalizeDuduReadonlyManagedProject(projectRoot, {
          ...fixture.source,
          lockedScriptPath: alternateLockedScript,
        })).rejects.toThrow(/source 与不可变 import receipt 不一致/u);
        await expectMissing(currentActivationPath);

        // import receipt 指纹/内容冲突。
        const importPath = path.join(projectRoot, IMPORT_RELATIVE_PATH);
        const importBytes = await readFile(importPath);
        const badImport = JSON.parse(importBytes.toString("utf8")) as Record<string, unknown>;
        badImport.contractSha256 = "f".repeat(64);
        await writeFile(importPath, `${JSON.stringify(badImport, null, 2)}\n`);
        await expect(finalizeDuduReadonlyManagedProject(projectRoot, fixture.source))
          .rejects.toThrow();
        await expectMissing(currentActivationPath);
        await writeFile(importPath, importBytes);

        // registration receipt 冲突。
        const registrationPath = path.join(projectRoot, REGISTRATION_RELATIVE_PATH);
        const registrationBytes = await readFile(registrationPath);
        const badRegistration = JSON.parse(registrationBytes.toString("utf8")) as Record<string, unknown>;
        badRegistration.importFingerprint = "e".repeat(64);
        await writeFile(registrationPath, `${JSON.stringify(badRegistration, null, 2)}\n`);
        await expect(finalizeDuduReadonlyManagedProject(projectRoot, fixture.source))
          .rejects.toThrow();
        await expectMissing(currentActivationPath);
        await writeFile(registrationPath, registrationBytes);

        // registry 同一 projectId 指向另一个 root 时失败，不选择任一候选。
        const registryBytes = await readFile(fixture.registryPath);
        const registry = JSON.parse(registryBytes.toString("utf8")) as Array<Record<string, unknown>>;
        const otherEntry = registry.find((entry) => entry.primaryRoot === other.paths.root)!;
        otherEntry.id = staged.shell.project.id;
        await writeFile(fixture.registryPath, `${JSON.stringify(registry, null, 2)}\n`);
        await expect(finalizeDuduReadonlyManagedProject(projectRoot, fixture.source))
          .rejects.toThrow();
        await expectMissing(currentActivationPath);
        await writeFile(fixture.registryPath, registryBytes);

        const recovered = await finalizeDuduReadonlyManagedProject(projectRoot, fixture.source);
        expect(recovered).toMatchObject({
          projectId: staged.shell.project.id,
          activationId: reactivated!.activationId,
          replayedRegistration: true,
          replayedActivation: false,
        });
        const recoveredBytes = await readFile(currentActivationPath);
        expect(recoveredBytes.byteLength).toBeGreaterThan(0);

        // 同一 current activation 重放只读取既有不可变 receipt。
        const replay = await finalizeDuduReadonlyManagedProject(projectRoot, fixture.source);
        expect(replay).toMatchObject({
          projectId: recovered.projectId,
          activationId: recovered.activationId,
          replayedRegistration: true,
          replayedActivation: true,
          activation: { fingerprint: recovered.activation.fingerprint },
        });
        expect(await readFile(currentActivationPath)).toEqual(recoveredBytes);

        // 原 activation receipt 永不覆盖/删除；目录同时保留旧、新两份不可变证据。
        expect(await readFile(firstActivationPath)).toEqual(firstActivationBytes);
        expect((await readdir(path.join(projectRoot, ACTIVATION_RELATIVE_ROOT))).sort()).toEqual([
          `${firstFinalization.activationId}.json`,
          `${recovered.activationId}.json`,
        ].sort());
      });
    } finally {
      await fixture.cleanup();
    }
  }, 240_000);

  it("首次 finalize 前出现 generation 动态记录仍由原零调用门拒绝，且不登记不激活", async () => {
    const fixture = await createDuduReadonlySourceFixture();
    try {
      await withFixtureRegistry(fixture, async () => {
        const staged = await stageDuduReadonlyManagedProject({
          projectsRoot: fixture.projectsRoot,
          source: fixture.source,
        });
        const u29 = staged.receipt.units.find((unit) => unit.unitId === "S1E01-U29")!;
        const pack = await readStudioUnitGridGenerationFrozenPack(staged.shell.paths.root, u29.packId!);
        expect(pack).not.toBeNull();
        await createStudioGenerationPlan(staged.shell.paths.root, {
          nodes: [{ targetKind: "unit-grid", unitId: "S1E01-U29" }],
          sourceCommandRequestId: "p30-initial-finalize-zero-call-guard-plan-1",
        });

        await expect(finalizeDuduReadonlyManagedProject(staged.shell.paths.root, fixture.source))
          .rejects.toThrow(/零调用闭包/u);
        expect(await listRegisteredProjects()).toEqual([]);
        await expectMissing(path.join(staged.shell.paths.root, REGISTRATION_RELATIVE_PATH));
        expect(await getActiveProjectStateReadOnly()).toBeNull();
      });
    } finally {
      await fixture.cleanup();
    }
  }, 180_000);
});
