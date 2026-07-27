import { access, chmod, mkdtemp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectCache } from "../src/core/cache.js";
import { listProjectLocks } from "../src/core/locks.js";
import { cancelPublication, failPublication, preflightPublication } from "../src/core/publication.js";
import { scanAndPersist } from "../src/core/service.js";
import { ensureSidecar, getSidecarPaths, listEvents, loadIndex, writeJsonAtomic } from "../src/core/sidecar.js";
import { scanProject } from "../src/core/scanner.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "ai-canvas-scan-"));
  roots.push(root);
  const config = await ensureSidecar(root);
  config.sourceRoots = [];
  config.outputRoots = [root];
  config.hardLocks = [];
  await writeJsonAtomic(getSidecarPaths(root).config, config);
  return root;
}

async function image(filePath: string, valid = true): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  if (!valid) {
    await writeFile(filePath, "broken", "utf8");
    return;
  }
  await sharp({ create: { width: 941, height: 1672, channels: 3, background: "#b88a3a" } }).png().toFile(filePath);
}

async function writeInfo(directory: string, content: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "00_信息.md"), content, "utf8");
}

describe("真实文件扫描与状态推断", () => {
  it("发布预留中的半成品不进入索引，发布失败后重新按真实文件机械验收", async () => {
    const root = await fixtureRoot();
    const directory = path.join(root, "EP11_15s_001_写入中素材");
    await writeInfo(directory, "首帧提示词：发布预留并发保护。\n");
    const requestedPath = path.join(directory, "EP11_15s_001_首帧_raw.png");
    const intent = await preflightPublication(root, {
      idempotencyKey: "scanner-reserved-partial-output-v1",
      requestedPath,
      kind: "raw-image",
      variant: "start",
      context: { purpose: "generation-output", itemId: "main-ep11-unit001" },
    });
    await writeFile(intent.targetPath, Buffer.alloc(60_000, 11));

    const duringWrite = await scanAndPersist(root);
    expect(duringWrite.scanStats).toMatchObject({ discoveredFiles: 2, candidateFiles: 1, reservedPublicationFilesSkipped: 1 });
    expect(duringWrite.artifacts.some((artifact) => artifact.path === intent.targetPath)).toBe(false);
    expect(duringWrite.summary.mechanicalFailures).toBe(0);
    expect(duringWrite.warnings.some((warning) => warning.includes("仍处于发布预留状态"))).toBe(true);

    await failPublication(root, {
      intentId: intent.id,
      reservationToken: intent.reservationToken,
      expectedRevision: intent.revision,
      reason: "模拟生成进程失败并保留部分文件供诊断",
    });
    const afterFailure = await scanAndPersist(root);
    expect(afterFailure.scanStats).toMatchObject({ candidateFiles: 2, reservedPublicationFilesSkipped: 0 });
    expect(afterFailure.artifacts.find((artifact) => artifact.path === intent.targetPath)?.check.ok).toBe(false);
    expect(afterFailure.summary.mechanicalFailures).toBe(1);
  });

  it("发布预留中的自动参考资产不会绕过写入中保护", async () => {
    const root = await fixtureRoot();
    const requestedPath = path.join(root, "01_硬锁参考图", "EP13_15s_001_正在生成的硬锁_raw.png");
    const intent = await preflightPublication(root, {
      idempotencyKey: "scanner-reserved-reference-asset-v1",
      requestedPath,
      kind: "raw-image",
      context: { purpose: "generation-output", itemId: "main-ep13-unit001" },
    });
    await writeFile(intent.targetPath, Buffer.alloc(60_000, 13));

    const index = await scanAndPersist(root);
    expect(index.scanStats).toMatchObject({ reservedPublicationFilesSkipped: 1, referenceAssets: 0 });
    expect(index.artifacts.some((artifact) => artifact.path === intent.targetPath)).toBe(false);
    expect(index.items.some((item) => item.type === "asset" && item.sourcePaths.includes(intent.targetPath))).toBe(false);
  });

  it("发布侧车损坏时持久扫描失败关闭并保留旧索引，只读预检给出明确警告", async () => {
    const root = await fixtureRoot();
    const directory = path.join(root, "EP12_15s_001_损坏侧车");
    await writeInfo(directory, "首帧提示词：验证发布侧车损坏时不提交新索引。\n");
    const baseline = await scanAndPersist(root);
    await writeFile(getSidecarPaths(root).publications, `${JSON.stringify({
      schemaVersion: 1,
      revision: 1,
      intents: [{ targetPath: path.join(directory, "EP12_15s_001_首帧_raw.png") }],
      receipts: [],
      updatedAt: new Date().toISOString(),
    })}\n`, "utf8");

    await expect(scanAndPersist(root)).rejects.toThrow("发布预留侧车无法读取");
    expect((await loadIndex(root))?.scanId).toBe(baseline.scanId);
    expect(await listProjectLocks(root)).toEqual([]);

    const preview = await scanProject({ projectRoot: root, persist: false });
    expect(preview.warnings.some((warning) => warning.includes("无法读取发布预留快照"))).toBe(true);
    expect((await loadIndex(root))?.scanId).toBe(baseline.scanId);
  });

  it("大项目复用未变化机械检查，只重检一个已变化文件，并让哈希缓存可继续复用", async () => {
    const root = await fixtureRoot();
    const png = await sharp({ create: { width: 320, height: 568, channels: 3, background: "#b88a3a" } }).png().toBuffer();
    const unitCount = 48;
    await Promise.all(Array.from({ length: unitCount }, async (_, index) => {
      const unit = String(index + 1).padStart(3, "0");
      const directory = path.join(root, `EP01_15s_${unit}_增量扫描`);
      await mkdir(directory, { recursive: true });
      await Promise.all([
        writeFile(path.join(directory, "00_信息.md"), `首帧提示词：第 ${unit} 单元。\n`, "utf8"),
        writeFile(path.join(directory, `EP01_15s_${unit}_首帧_raw.png`), png),
      ]);
    }));

    const first = await scanAndPersist(root);
    expect(first.summary.total).toBe(unitCount);
    expect(first.scanStats).toMatchObject({ candidateFiles: unitCount * 2, inspectedChecks: unitCount * 2, reusedChecks: 0 });

    const unchanged = await scanAndPersist(root);
    expect(unchanged.scanStats).toMatchObject({ inspectedChecks: 0, reusedChecks: unitCount * 2 });

    const changedPath = path.join(root, "EP01_15s_024_增量扫描", "EP01_15s_024_首帧_raw.png");
    const changedPng = await sharp({ create: { width: 321, height: 568, channels: 3, background: "#315a68" } }).png().toBuffer();
    await writeFile(changedPath, changedPng);
    const changed = await scanAndPersist(root);
    expect(changed.scanStats).toMatchObject({ inspectedChecks: 1, reusedChecks: unitCount * 2 - 1 });
    expect(changed.artifacts.find((artifact) => artifact.path === changedPath)?.check.width).toBe(321);

    const firstHashed = await scanAndPersist(root, true);
    expect(firstHashed.scanStats).toMatchObject({ includeHashes: true, inspectedChecks: unitCount * 2, reusedChecks: 0 });
    expect(firstHashed.artifacts.every((artifact) => Boolean(artifact.check.sha256))).toBe(true);
    const secondHashed = await scanAndPersist(root, { includeHashes: true });
    expect(secondHashed.scanStats).toMatchObject({ includeHashes: true, inspectedChecks: 0, reusedChecks: unitCount * 2 });
  }, 60_000);

  it("扫描取消后不覆盖索引、SQLite提交点或审计事件，并释放扫描锁", async () => {
    const root = await fixtureRoot();
    for (let index = 1; index <= 12; index += 1) {
      const unit = String(index).padStart(3, "0");
      const directory = path.join(root, `EP03_15s_${unit}_取消测试`);
      await writeInfo(directory, `首帧提示词：取消测试 ${unit}。\n`);
      await image(path.join(directory, `EP03_15s_${unit}_首帧_raw.png`));
    }
    const baseline = await scanAndPersist(root);
    const changedPath = path.join(root, "EP03_15s_001_取消测试", "EP03_15s_001_首帧_raw.png");
    const baselineArtifact = baseline.artifacts.find((artifact) => artifact.path === changedPath)!;
    await sharp({ create: { width: 777, height: 888, channels: 3, background: "#23576b" } }).png().toFile(changedPath);
    const baselineEvents = (await listEvents(root, 1_000)).filter((event) => event.type === "project.scanned");
    const controller = new AbortController();

    await expect(scanAndPersist(root, {
      signal: controller.signal,
      onProgress: (progress) => {
        if (progress.phase === "inspect" && progress.completedChecks >= 1) controller.abort("测试主动取消");
      },
    })).rejects.toMatchObject({ name: "AbortError" });

    const after = await loadIndex(root);
    const afterEvents = (await listEvents(root, 1_000)).filter((event) => event.type === "project.scanned");
    expect(after?.scanId).toBe(baseline.scanId);
    expect(after?.artifacts.find((artifact) => artifact.id === baselineArtifact.id)?.check.width).toBe(941);
    expect(afterEvents.map((event) => event.id)).toEqual(baselineEvents.map((event) => event.id));
    const cache = new ProjectCache(root);
    try {
      expect(cache.getArtifact(baselineArtifact.id)?.check.width).toBe(941);
    } finally {
      cache.close();
    }
    expect(await listProjectLocks(root)).toEqual([]);
  }, 60_000);

  it("取消扫描会终止正在运行的 ffprobe 子进程", async () => {
    const root = await fixtureRoot();
    const directory = path.join(root, "EP08_15s_001_ffprobe取消");
    await writeInfo(directory, "首帧提示词：验证音视频探测可取消。\n");
    const baseline = await scanAndPersist(root);
    const videoPath = path.join(directory, "EP08_15s_001_测试.mp4");
    await writeFile(videoPath, Buffer.alloc(60_000, 1));
    const pidPath = path.join(root, "fake-ffprobe.pid");
    const markerPath = path.join(root, "fake-ffprobe.terminated");
    const fakeProbe = path.join(root, "fake-ffprobe.mjs");
    await writeFile(fakeProbe, `#!/usr/bin/env node\nimport { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(pidPath)}, String(process.pid));\nprocess.on("SIGTERM", () => { writeFileSync(${JSON.stringify(markerPath)}, "terminated"); process.exit(143); });\nsetInterval(() => {}, 1000);\n`, "utf8");
    await chmod(fakeProbe, 0o755);
    const previousProbe = process.env.FFPROBE_PATH;
    process.env.FFPROBE_PATH = fakeProbe;
    const controller = new AbortController();
    try {
      const scan = scanAndPersist(root, { signal: controller.signal });
      let pidReady = false;
      for (let attempt = 0; attempt < 2_000; attempt += 1) {
        if (await access(pidPath).then(() => true).catch(() => false)) break;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      pidReady = await access(pidPath).then(() => true).catch(() => false);
      if (!pidReady) {
        controller.abort("ffprobe 启动等待超时");
        await scan.catch(() => undefined);
        throw new Error("真实 ffprobe 子进程没有在 10 秒内启动。 ");
      }
      const pid = Number(await readFile(pidPath, "utf8"));
      let preflightSettled = false;
      const concurrentPreflight = preflightPublication(root, {
        idempotencyKey: "scanner-publication-snapshot-race-v1",
        requestedPath: path.join(directory, "EP08_15s_001_排队首帧_raw.png"),
        kind: "raw-image",
        variant: "start",
        context: { purpose: "generation-output", itemId: "main-ep08-unit001" },
      }).then((intent) => { preflightSettled = true; return intent; });
      const queuedIntent = await Promise.race([
        concurrentPreflight,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("扫描不应长时间阻塞新的发布预留。")), 5_000)),
      ]);
      expect(preflightSettled).toBe(true);
      await cancelPublication(root, {
        intentId: queuedIntent.id,
        reservationToken: queuedIntent.reservationToken,
        expectedRevision: queuedIntent.revision,
        reason: "扫描期间发布预留不被长扫描阻塞的测试结束",
      });
      controller.abort("终止真实 ffprobe 子进程测试");
      await expect(scan).rejects.toMatchObject({ name: "AbortError" });
      await expect(access(markerPath)).resolves.toBeUndefined();
      let processAlive = true;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        try { process.kill(pid, 0); }
        catch { processAlive = false; break; }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(processAlive).toBe(false);
      expect((await loadIndex(root))?.scanId).toBe(baseline.scanId);
      expect(await listProjectLocks(root)).toEqual([]);
    } finally {
      if (previousProbe === undefined) delete process.env.FFPROBE_PATH;
      else process.env.FFPROBE_PATH = previousProbe;
    }
  }, 60_000);

  it("只读预检不会创建侧车或登记项目", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ai-canvas-preview-"));
    roots.push(root);
    await writeInfo(path.join(root, "EP01_15s_001_预检"), "首帧提示词：预检。\n尾帧提示词：预检。\n");
    const index = await scanProject({ projectRoot: root, persist: false });
    expect(index.summary.total).toBe(1);
    await expect(access(path.join(root, ".aicanvas"))).rejects.toThrow();
  });

  it("把完整且已视觉验收的首尾帧推进到待视频", async () => {
    const root = await fixtureRoot();
    const directory = path.join(root, "新版", "EP01_15s_001_测试单元");
    await writeInfo(directory, "# EP01_15s_001\n\n首帧提示词：测试\n尾帧提示词：测试\n最终状态：通过\n");
    await image(path.join(directory, "EP01_15s_001_首帧_raw.png"));
    await image(path.join(directory, "EP01_15s_001_首帧_labeled.png"));
    await image(path.join(directory, "EP01_15s_001_尾帧_raw.png"));
    await image(path.join(directory, "EP01_15s_001_尾帧_labeled.png"));

    const index = await scanProject({ projectRoot: root });
    expect(index.items.find((item) => item.id === "main-ep01-unit001")?.status).toBe("待视频");
    expect(index.summary.total).toBe(1);
    expect(index.summary.rawImages).toBe(2);
    expect(index.summary.labeledImages).toBe(2);
    await writeJsonAtomic(getSidecarPaths(root).overrides, { schemaVersion: 1, items: { "main-ep01-unit001": { status: "已完成", updatedAt: new Date().toISOString() } } });
    const guarded = await scanProject({ projectRoot: root });
    // 旧 00_信息.md 的“最终状态：通过”只能用于初始进度推断；一旦有人显式
    // 声称完成，缺少内容绑定 ReviewRecord 时必须保守回到图片验收。
    expect(guarded.items.find((item) => item.id === "main-ep01-unit001")?.status).toBe("待视觉验收");
    expect(guarded.warnings.some((warning) => warning.includes("已完成") && warning.includes("缺少可解码视频"))).toBe(true);
    expect(guarded.warnings.some((warning) => warning.includes("当前权威图片缺少仍有效的视觉通过证据"))).toBe(true);
  });

  it("区分缺尾帧、缺配对和损坏图片", async () => {
    const root = await fixtureRoot();
    const onlyStart = path.join(root, "EP01_15s_002_只有首帧");
    await writeInfo(onlyStart, "首帧提示词：测试\n尾帧提示词：测试\n");
    await image(path.join(onlyStart, "EP01_15s_002_首帧_raw.png"));

    const missingLabel = path.join(root, "EP01_15s_003_缺标注");
    await writeInfo(missingLabel, "首帧提示词：测试\n尾帧提示词：测试\n");
    await image(path.join(missingLabel, "EP01_15s_003_首帧_raw.png"));
    await image(path.join(missingLabel, "EP01_15s_003_尾帧_raw.png"));

    const broken = path.join(root, "EP01_15s_004_损坏");
    await writeInfo(broken, "首帧提示词：测试\n尾帧提示词：测试\n");
    await image(path.join(broken, "EP01_15s_004_首帧_raw.png"), false);
    await image(path.join(broken, "EP01_15s_004_首帧_labeled.png"));
    await image(path.join(broken, "EP01_15s_004_尾帧_raw.png"));
    await image(path.join(broken, "EP01_15s_004_尾帧_labeled.png"));

    const index = await scanProject({ projectRoot: root });
    expect(index.items.find((item) => item.id.endsWith("unit002"))?.status).toBe("待尾帧");
    expect(index.items.find((item) => item.id.endsWith("unit003"))?.status).toBe("待机械验收");
    expect(index.items.find((item) => item.id.endsWith("unit004"))?.status).toBe("待机械验收");
    expect(index.summary.mechanicalFailures).toBe(1);
  });

  it("旧版和备份不会压过新版权威素材", async () => {
    const root = await fixtureRoot();
    const current = path.join(root, "新版", "EP02_15s_001_当前");
    const old = path.join(root, "旧版_弃用", "EP02_15s_001_历史");
    await writeInfo(current, "首帧提示词：新\n尾帧提示词：新\n最终状态：通过\n");
    await writeInfo(old, "首帧提示词：旧\n尾帧提示词：旧\n最终状态：通过\n");
    for (const variant of ["首帧", "尾帧"]) {
      await image(path.join(current, `EP02_15s_001_${variant}_raw.png`));
      await image(path.join(current, `EP02_15s_001_${variant}_labeled.png`));
      await image(path.join(old, `EP02_15s_001_${variant}_raw.png`));
      await image(path.join(old, `EP02_15s_001_${variant}_labeled.png`));
    }

    const index = await scanProject({ projectRoot: root });
    const item = index.items.find((candidate) => candidate.id === "main-ep02-unit001")!;
    const authoritative = index.artifacts.filter((artifact) => item.artifactIds.includes(artifact.id) && artifact.authoritative);
    expect(authoritative.every((artifact) => !artifact.path.includes("旧版_弃用"))).toBe(true);
    expect(index.summary.rawImages).toBe(2);
  });

  it("只有旧版文件的生产单元会直接分流为弃用", async () => {
    const root = await fixtureRoot();
    const old = path.join(root, "旧版", "EP07_15s_009_历史单元");
    await writeInfo(old, "首帧提示词：仅供历史追溯。\n");
    const index = await scanProject({ projectRoot: root });
    expect(index.items.find((item) => item.id === "main-ep07-unit009")?.status).toBe("弃用");
    expect(index.summary.deprecated).toBe(1);
    expect(index.summary.active).toBe(0);
  });

  it("资产库与镜头硬锁按权威文件名精确关联", async () => {
    const root = await fixtureRoot();
    const assetDirectory = path.join(root, "00_全剧资产锁定", "01_人物三视图");
    const ahang = path.join(assetDirectory, "P01_小阿航_8岁动漫三视图_硬锁.png");
    const ayi = path.join(assetDirectory, "P02_小阿依_7岁动漫三视图_硬锁.png");
    await image(ahang);
    await image(ayi);

    const directory = path.join(root, "EP01_15s_001_硬锁测试");
    await writeInfo(directory, `首帧提示词：只使用 ${ahang}\n尾帧提示词：保持小阿航连续性\n`);

    const index = await scanProject({ projectRoot: root });
    const unit = index.items.find((item) => item.id === "main-ep01-unit001")!;
    const locks = index.project.hardLocks.filter((lock) => unit.hardLockIds.includes(lock.id));
    expect(index.items.filter((item) => item.type === "asset")).toHaveLength(2);
    expect(index.project.hardLocks).toHaveLength(2);
    expect(locks.map((lock) => lock.name)).toEqual(["P01_小阿航_8岁动漫三视图_硬锁"]);
  });

  it("把 15 秒目录内的原镜头识别为子节点而不混入单元素材", async () => {
    const root = await fixtureRoot();
    const unitDirectory = path.join(root, "EP01_15s_001_组合测试");
    await mkdir(unitDirectory, { recursive: true });
    const lockPath = path.join(root, "00_全剧资产锁定", "01_人物三视图", "P01_阿航_三视图_硬锁.png");
    await image(lockPath);
    await writeFile(path.join(unitDirectory, "EP01_15s_001_融合提示词.md"), `首帧提示词：阿航组合首帧，参考 ${lockPath}\n尾帧提示词：组合尾帧\n`, "utf8");
    const shotDirectory = path.join(unitDirectory, "EP01_镜01_人物抬头");
    await writeInfo(shotDirectory, "镜头提示词：人物抬头。\n");
    const shotImage = path.join(shotDirectory, "EP01_镜01_人物抬头_raw.png");
    await image(shotImage);
    await image(path.join(shotDirectory, "EP01_镜01_人物抬头_labeled.png"));

    const index = await scanProject({ projectRoot: root });
    const unit = index.items.find((item) => item.id === "main-ep01-unit001")!;
    const shot = index.items.find((item) => item.id === "main-ep01-unit001-shot1")!;
    expect(unit.type).toBe("unit");
    expect(shot.type).toBe("shot");
    expect(shot.parentId).toBe(unit.id);
    expect(shot.unit).toBe(1);
    expect(shot.sourcePaths).toContain(shotImage);
    expect(unit.sourcePaths).not.toContain(shotImage);
    expect(shot.dependencies).toEqual([unit.id]);
    expect(shot.status).toBe("待视觉验收");
    expect(shot.nextAction).toContain("前后镜连续性");
    expect(shot.hardLockIds).toEqual(unit.hardLockIds);
  });

  it("项目主根整体移动后素材 ID 与 aicanvas URI 保持稳定", async () => {
    const root = await fixtureRoot();
    const directory = path.join(root, "EP09_15s_001_迁移测试");
    await writeInfo(directory, "首帧提示词：迁移前后保持身份。\n尾帧提示词：继续。\n");
    await image(path.join(directory, "EP09_15s_001_首帧_raw.png"));
    const before = await scanProject({ projectRoot: root });
    const artifactBefore = before.artifacts.find((artifact) => artifact.kind === "raw-image")!;
    const moved = `${root}-moved`;
    await rename(root, moved);
    roots[roots.indexOf(root)] = moved;
    const after = await scanProject({ projectRoot: moved });
    const artifactAfter = after.artifacts.find((artifact) => artifact.kind === "raw-image")!;
    expect(artifactAfter.id).toBe(artifactBefore.id);
    expect(artifactAfter.uri).toBe(artifactBefore.uri);
    expect(artifactAfter.path).not.toBe(artifactBefore.path);
    expect(artifactAfter.relativePath).toBe(artifactBefore.relativePath);
  });
});
