import {
  appendFile,
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  __setStudioUnitGridReadEpochObserverForTests,
  memoStudioUnitGridRead,
  verifyStudioUnitGridMediaOnce,
  withFreshStudioUnitGridReadEpoch,
  withStudioUnitGridReadEpoch,
} from "../src/core/studio-unit-grid-read-epoch.js";

const temporaryRoots: string[] = [];

async function fixture(): Promise<{
  root: string;
  material: string;
  production: string;
  generation: string;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "studio-unit-grid-read-epoch-"));
  temporaryRoots.push(root);
  const databaseRoot = path.join(root, ".aicanvas");
  await mkdir(databaseRoot, { recursive: true });
  const material = path.join(databaseRoot, "material-studio.sqlite");
  const production = path.join(databaseRoot, "studio-production.sqlite");
  const generation = path.join(databaseRoot, "studio-generation-ledger.sqlite");
  await Promise.all([
    writeFile(material, "material-v1"),
    writeFile(production, "production-v1"),
    writeFile(generation, "generation-v1"),
  ]);
  return { root, material, production, generation };
}

afterEach(async () => {
  __setStudioUnitGridReadEpochObserverForTests(null);
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("studio unit-grid read epoch", () => {
  it("初建嵌套复用同一 memo，fresh-currentness 强制使用独立 memo", async () => {
    const target = await fixture();
    const phases: string[] = [];
    __setStudioUnitGridReadEpochObserverForTests((event) => {
      if (event.kind === "begin") phases.push(event.phase);
    });
    let reads = 0;
    const read = () => memoStudioUnitGridRead(target.root, "production:unit:U03", async () => {
      reads += 1;
      return { revision: reads };
    });

    const initial = await withStudioUnitGridReadEpoch(target.root, async () => {
      const first = await read();
      const nested = await withStudioUnitGridReadEpoch(target.root, read);
      return [first, nested];
    });
    const fresh = await withFreshStudioUnitGridReadEpoch(target.root, read);

    expect(initial).toEqual([{ revision: 1 }, { revision: 1 }]);
    expect(fresh).toEqual({ revision: 2 });
    expect(reads).toBe(2);
    expect(phases).toEqual(["initial", "fresh-currentness"]);
  });

  it.each([
    ["主库", (target: Awaited<ReturnType<typeof fixture>>) => target.material],
    ["非空 WAL", (target: Awaited<ReturnType<typeof fixture>>) => `${target.production}-wal`],
    ["rollback journal", (target: Awaited<ReturnType<typeof fixture>>) => `${target.generation}-journal`],
  ])("%s 在 epoch 内漂移时失败关闭", async (_label, selectPath) => {
    const target = await fixture();
    await expect(withStudioUnitGridReadEpoch(target.root, async () => {
      await appendFile(selectPath(target), "changed");
      return "must-not-return";
    })).rejects.toThrow(/输入身份漂移/u);
  });

  it("同一媒体 SHA 每个 epoch 只验一次，fresh 会重新验证", async () => {
    const target = await fixture();
    const media = path.join(target.root, "reference.png");
    await writeFile(media, "stable-media");
    const sha = "a".repeat(64);
    let verifies = 0;
    const verify = () => verifyStudioUnitGridMediaOnce(target.root, sha, media, async () => {
      verifies += 1;
      return true;
    });

    await withStudioUnitGridReadEpoch(target.root, async () => {
      expect(await Promise.all([verify(), verify(), verify()])).toEqual([true, true, true]);
    });
    await withFreshStudioUnitGridReadEpoch(target.root, verify);

    expect(verifies).toBe(2);
  });

  it("无 unit-grid epoch 时直接保留普通 panel verifier 的错误语义", async () => {
    const target = await fixture();
    const expected = new Error("ordinary-panel-media-missing");
    let verifierCalls = 0;
    await expect(verifyStudioUnitGridMediaOnce(
      target.root,
      "c".repeat(64),
      path.join(target.root, "missing-media.png"),
      async () => {
        verifierCalls += 1;
        throw expected;
      },
    )).rejects.toBe(expected);
    expect(verifierCalls).toBe(1);
  });

  it("同 SHA 异路径与 SHA 后媒体替换都失败关闭", async () => {
    const target = await fixture();
    const first = path.join(target.root, "first.png");
    const second = path.join(target.root, "second.png");
    await Promise.all([writeFile(first, "one"), writeFile(second, "two")]);
    const sha = "b".repeat(64);

    await expect(withStudioUnitGridReadEpoch(target.root, async () => {
      await verifyStudioUnitGridMediaOnce(target.root, sha, first, async () => true);
      await verifyStudioUnitGridMediaOnce(target.root, sha, second, async () => true);
    })).rejects.toThrow(/不同对象路径/u);

    await expect(withStudioUnitGridReadEpoch(target.root, async () => {
      await verifyStudioUnitGridMediaOnce(target.root, sha, first, async () => true);
      await writeFile(first, "replaced-after-verification");
    })).rejects.toThrow(/输入身份漂移/u);
  });
});
