import { execFile, spawn } from "node:child_process";
import { access, chmod, mkdtemp, mkdir, readFile, rename, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import {
  cancelPublication,
  failPublication,
  getPublicationIntent,
  listPublicationIntents,
  listPublicationReceipts,
  preflightPublication,
  preflightPublicationBundle,
  publicationTargetExists,
  registerPublication,
  registerPublicationBundle,
} from "../src/core/publication.js";
import { ensureSidecar, getSidecarPaths, listEvents, writeJsonAtomic } from "../src/core/sidecar.js";
import { executeIdempotentCommand, listCommandLedger, reconcileCommand } from "../src/core/command-bus.js";
import type { PublicationIntent, PublicationReceipt } from "../src/core/publication.js";
import { readMachineMediaRuntimeSnapshot } from "../src/core/media-runtime.js";
import { listProjectLocks } from "../src/core/locks.js";

const roots: string[] = [];
const execFileAsync = promisify(execFile);
afterEach(async () => {
  delete process.env.AI_CANVAS_TEST_COMMAND_FAIL_TERMINAL_LEDGER_ONCE;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function waitForPath(filePath: string, attempts = 300): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await access(filePath).then(() => true).catch(() => false)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`等待文件超时：${filePath}`);
}

async function fixture(): Promise<{ root: string; output: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "ai-canvas-publication-"));
  roots.push(root);
  const output = path.join(root, "outputs");
  await mkdir(output, { recursive: true });
  const config = await ensureSidecar(root);
  config.sourceRoots = [];
  config.outputRoots = [output];
  await writeJsonAtomic(getSidecarPaths(root).config, config);
  return { root, output };
}

describe("轻量发布预检与注册", () => {
  it("预留新版本路径、幂等重放，并在图片校验后生成不可变回执", async () => {
    const { root, output } = await fixture();
    const existingPath = path.join(output, "EP01_首帧_v001.png");
    await sharp({ create: { width: 720, height: 1280, channels: 3, background: "#4e6372" } }).png().toFile(existingPath);
    const original = await readFile(existingPath);
    const input = {
      idempotencyKey: "publish-frame-ep01-v1",
      requestedPath: existingPath,
      allowedRoot: output,
      kind: "raw-image" as const,
      variant: "start" as const,
      context: { purpose: "generation-output" as const, itemId: "main-ep01-unit001", jobId: "gen-001", metadata: { model: "test" } },
      note: "首帧新版本",
    };
    const intent = await preflightPublication(root, input);
    expect(intent.status).toBe("reserved");
    expect(intent.targetPath).toBe(path.join(output, "EP01_首帧_v002.png"));
    expect(await publicationTargetExists(intent)).toBe(false);
    const replay = await preflightPublication(root, input);
    expect(replay.id).toBe(intent.id);
    expect(replay.reservationToken).toBe(intent.reservationToken);
    await expect(preflightPublication(root, { ...input, note: "不同发布参数" })).rejects.toThrow("幂等键已用于不同参数");
    await expect(registerPublication(root, { intentId: intent.id, reservationToken: "wrong-token", expectedRevision: 1 })).rejects.toThrow("预留令牌不匹配");
    expect((await getPublicationIntent(root, intent.id))?.status).toBe("reserved");

    await sharp({ create: { width: 1080, height: 1920, channels: 3, background: "#8a623e" } }).png().toFile(intent.targetPath);
    const receipt = await registerPublication(root, { intentId: intent.id, reservationToken: intent.reservationToken, expectedRevision: 1 });
    expect(receipt.check).toMatchObject({ ok: true, exists: true, decodable: true, width: 1080, height: 1920 });
    expect(receipt.check.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect((await registerPublication(root, { intentId: intent.id, reservationToken: intent.reservationToken, expectedRevision: 2 })).id).toBe(receipt.id);
    expect(await readFile(existingPath)).toEqual(original);
    expect((await listPublicationReceipts(root))).toEqual([receipt]);
    expect((await getPublicationIntent(root, intent.id))?.status).toBe("registered");
    const eventTypes = (await listEvents(root, 50)).map((event) => event.type);
    expect(eventTypes).toContain("publication.preflighted");
    expect(eventTypes).toContain("publication.registered");
    await expect(cancelPublication(root, { intentId: intent.id, reservationToken: intent.reservationToken, expectedRevision: 2, reason: "不应取消已注册发布" })).rejects.toThrow("registered");
    await sharp({ create: { width: 1080, height: 1920, channels: 3, background: "#172b3a" } }).png().toFile(intent.targetPath);
    await expect(registerPublication(root, { intentId: intent.id, reservationToken: intent.reservationToken, expectedRevision: 2 })).rejects.toThrow("已注册文件内容发生变化");
    expect((await getPublicationIntent(root, intent.id))?.status).toBe("registered");
  });

  it("以共同版本预留 raw/labeled，并在一次原子提交中登记两个回执", async () => {
    const { root, output } = await fixture();
    const occupiedRaw = path.join(output, "EP01_宫格05_raw.png");
    await sharp({ create: { width: 720, height: 1280, channels: 3, background: "#282c35" } }).png().toFile(occupiedRaw);
    const bundle = await preflightPublicationBundle(root, {
      bundleId: "generation-bundle-ep01-panel05",
      idempotencyKey: "generation-pair-ep01-panel05",
      primaryRequestedPath: occupiedRaw,
      companionRequestedPath: path.join(output, "EP01_宫格05_labeled.png"),
      variant: "generic",
      context: { purpose: "generation-output", itemId: "main-ep01-unit008", jobId: "gen-panel05" },
    });
    expect(bundle.primary.targetPath).toBe(path.join(output, "EP01_宫格05_v002_raw.png"));
    expect(bundle.companion.targetPath).toBe(path.join(output, "EP01_宫格05_v002_labeled.png"));
    const replay = await preflightPublicationBundle(root, {
      bundleId: "generation-bundle-ep01-panel05",
      idempotencyKey: "generation-pair-ep01-panel05",
      primaryRequestedPath: occupiedRaw,
      companionRequestedPath: path.join(output, "EP01_宫格05_labeled.png"),
      variant: "generic",
      context: { purpose: "generation-output", itemId: "main-ep01-unit008", jobId: "gen-panel05" },
    });
    expect([replay.primary.id, replay.companion.id]).toEqual([bundle.primary.id, bundle.companion.id]);
    await expect(registerPublication(root, {
      intentId: bundle.primary.id,
      reservationToken: bundle.primary.reservationToken,
      expectedRevision: bundle.primary.revision,
    })).rejects.toThrow("必须使用 registerPublicationBundle");
    await expect(cancelPublication(root, {
      intentId: bundle.companion.id,
      reservationToken: bundle.companion.reservationToken,
      expectedRevision: bundle.companion.revision,
      reason: "不能单边取消事务成员",
    })).rejects.toThrow("不能单边取消或失败");

    await sharp({ create: { width: 1080, height: 1920, channels: 3, background: "#7e5538" } }).png().toFile(bundle.primary.targetPath);
    await sharp({ create: { width: 1080, height: 1920, channels: 3, background: "#875f42" } }).png().toFile(bundle.companion.targetPath);
    const registrationInput = {
      bundleId: bundle.bundleId,
      members: [
        { member: "companion" as const, intentId: bundle.companion.id, reservationToken: bundle.companion.reservationToken, expectedRevision: bundle.companion.revision },
        { member: "primary" as const, intentId: bundle.primary.id, reservationToken: bundle.primary.reservationToken, expectedRevision: bundle.primary.revision },
      ],
    };
    const [first, second] = await Promise.all([
      registerPublicationBundle(root, registrationInput),
      registerPublicationBundle(root, registrationInput),
    ]);
    expect(first.receipts.map((receipt) => receipt.bundleMember)).toEqual(["primary", "companion"]);
    expect(second.receipts.map((receipt) => receipt.id)).toEqual(first.receipts.map((receipt) => receipt.id));
    expect(first.receipts.every((receipt) => receipt.bundleId === bundle.bundleId)).toBe(true);
    expect(await listPublicationReceipts(root)).toHaveLength(2);
    expect((await getPublicationIntent(root, bundle.primary.id))?.status).toBe("registered");
    expect((await getPublicationIntent(root, bundle.companion.id))?.status).toBe("registered");
    expect((await listEvents(root, 100)).filter((event) => event.type === "publication.bundle-registered" && event.data?.bundleId === bundle.bundleId)).toHaveLength(1);
  });

  it("bundle 成员缺失时保持双 reserved，稳定无效时原子失败且零回执", async () => {
    const { root, output } = await fixture();
    const missing = await preflightPublicationBundle(root, {
      bundleId: "generation-bundle-missing-member",
      idempotencyKey: "generation-pair-missing-member",
      primaryRequestedPath: path.join(output, "missing_raw.png"),
      companionRequestedPath: path.join(output, "missing_labeled.png"),
      context: { purpose: "generation-output", itemId: "unit-missing", jobId: "gen-missing" },
    });
    await sharp({ create: { width: 1080, height: 1920, channels: 3, background: "#3d4d62" } }).png().toFile(missing.primary.targetPath);
    await expect(registerPublicationBundle(root, {
      bundleId: missing.bundleId,
      members: [
        { member: "primary", intentId: missing.primary.id, reservationToken: missing.primary.reservationToken, expectedRevision: missing.primary.revision },
        { member: "companion", intentId: missing.companion.id, reservationToken: missing.companion.reservationToken, expectedRevision: missing.companion.revision },
      ],
    })).rejects.toThrow("文件尚未落盘");
    expect((await getPublicationIntent(root, missing.primary.id))?.status).toBe("reserved");
    expect((await getPublicationIntent(root, missing.companion.id))?.status).toBe("reserved");
    expect(await listPublicationReceipts(root)).toHaveLength(0);

    const invalid = await preflightPublicationBundle(root, {
      bundleId: "generation-bundle-invalid-member",
      idempotencyKey: "generation-pair-invalid-member",
      primaryRequestedPath: path.join(output, "invalid-pair_raw.png"),
      companionRequestedPath: path.join(output, "invalid-pair_labeled.png"),
      context: { purpose: "generation-output", itemId: "unit-invalid", jobId: "gen-invalid" },
    });
    await sharp({ create: { width: 1080, height: 1920, channels: 3, background: "#62513c" } }).png().toFile(invalid.primary.targetPath);
    await writeFile(invalid.companion.targetPath, "");
    await expect(registerPublicationBundle(root, {
      bundleId: invalid.bundleId,
      members: [
        { member: "primary", intentId: invalid.primary.id, reservationToken: invalid.primary.reservationToken, expectedRevision: invalid.primary.revision },
        { member: "companion", intentId: invalid.companion.id, reservationToken: invalid.companion.reservationToken, expectedRevision: invalid.companion.revision },
      ],
    })).rejects.toThrow("发布事务注册失败");
    expect((await getPublicationIntent(root, invalid.primary.id))?.status).toBe("failed");
    expect((await getPublicationIntent(root, invalid.companion.id))?.status).toBe("failed");
    expect(await listPublicationReceipts(root)).toHaveLength(0);
  });

  it("拒绝配置根之外、侧车内部和通过符号链接逃逸的路径", async () => {
    const { root, output } = await fixture();
    const external = await mkdtemp(path.join(os.tmpdir(), "ai-canvas-publication-external-"));
    roots.push(external);
    const base = { idempotencyKey: "publish-path-boundary-001", kind: "other" as const, context: { purpose: "other" as const } };
    await expect(preflightPublication(root, { ...base, requestedPath: path.join(external, "outside.bin") })).rejects.toThrow("不在项目允许输出根");
    await expect(preflightPublication(root, { ...base, idempotencyKey: "publish-sidecar-boundary-001", requestedPath: path.join(root, ".aicanvas", "bad.bin") })).rejects.toThrow("不能写入 .aicanvas");
    const escaped = path.join(output, "escaped");
    await symlink(external, escaped, "dir");
    await expect(preflightPublication(root, { ...base, idempotencyKey: "publish-symlink-boundary-001", requestedPath: path.join(escaped, "bad.bin"), allowedRoot: output })).rejects.toThrow("符号链接逃逸");
  });

  it("最终文件无效时进入失败终态，并完整审计手工失败与取消", async () => {
    const { root, output } = await fixture();
    const invalid = await preflightPublication(root, { idempotencyKey: "publish-invalid-file-001", requestedPath: path.join(output, "invalid.bin"), kind: "other", context: { purpose: "import", itemId: "asset-001" } });
    await writeFile(invalid.targetPath, "");
    await expect(registerPublication(root, { intentId: invalid.id, reservationToken: invalid.reservationToken, expectedRevision: 1 })).rejects.toThrow("最终发布文件为空");
    const failed = await getPublicationIntent(root, invalid.id);
    expect(failed?.status).toBe("failed");
    expect(failed?.terminal?.reason).toContain("文件为空");
    await expect(registerPublication(root, { intentId: invalid.id, reservationToken: invalid.reservationToken, expectedRevision: 2 })).rejects.toThrow("failed");

    const cancelledIntent = await preflightPublication(root, { idempotencyKey: "publish-cancelled-file-001", requestedPath: path.join(output, "cancelled.mp4"), kind: "video", context: { purpose: "edit-render" } });
    const cancelled = await cancelPublication(root, { intentId: cancelledIntent.id, reservationToken: cancelledIntent.reservationToken, expectedRevision: 1, reason: "用户主动取消渲染" }, "user");
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.terminal?.reason).toBe("用户主动取消渲染");

    const manualIntent = await preflightPublication(root, { idempotencyKey: "publish-manual-failure-001", requestedPath: path.join(output, "failed.mp4"), kind: "video", context: { purpose: "edit-render" } });
    const manualFailure = await failPublication(root, { intentId: manualIntent.id, reservationToken: manualIntent.reservationToken, expectedRevision: 1, reason: "FFmpeg 子进程退出码为 1" });
    expect(manualFailure.status).toBe("failed");
    expect(await listPublicationIntents(root, "failed")).toHaveLength(2);
    const events = await listEvents(root, 100);
    expect(events.some((event) => event.type === "publication.failed" && event.data?.intentId === invalid.id)).toBe(true);
    expect(events.some((event) => event.type === "publication.cancelled" && event.actor === "user")).toBe(true);
  });

  it("发布 ffprobe 超时会失败闭合意图并终止完整探测进程组", async () => {
    const { root, output } = await fixture();
    const target = await preflightPublication(root, { idempotencyKey: "publish-probe-timeout-001", requestedPath: path.join(output, "timeout.mp4"), kind: "video", context: { purpose: "edit-render" } });
    await writeFile(target.targetPath, Buffer.alloc(60_000, 1));
    const pidPath = path.join(root, "fake-probe-pids.json");
    const fakeProbe = path.join(root, "fake-ffprobe.mjs");
    const grandchildScript = "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)";
    await writeFile(fakeProbe, `#!/usr/bin/env node\nimport { spawn } from "node:child_process";\nimport { writeFileSync } from "node:fs";\nprocess.on("SIGTERM",()=>{});\nconst child=spawn(process.execPath,["-e",${JSON.stringify(grandchildScript)}],{stdio:"ignore"});\nwriteFileSync(${JSON.stringify(pidPath)},JSON.stringify({parent:process.pid,child:child.pid}));\nsetInterval(()=>{},1000);\n`, "utf8");
    await chmod(fakeProbe, 0o755);
    const previousProbe = process.env.FFPROBE_PATH;
    const previousTimeout = process.env.AI_CANVAS_FFPROBE_TIMEOUT_MS;
    const previousGrace = process.env.AI_CANVAS_MEDIA_TERMINATION_GRACE_MS;
    process.env.FFPROBE_PATH = fakeProbe;
    process.env.AI_CANVAS_FFPROBE_TIMEOUT_MS = "250";
    process.env.AI_CANVAS_MEDIA_TERMINATION_GRACE_MS = "100";
    try {
      await expect(registerPublication(root, { intentId: target.id, reservationToken: target.reservationToken, expectedRevision: target.revision })).rejects.toThrow("ffprobe 校验超时");
      expect((await getPublicationIntent(root, target.id))?.status).toBe("failed");
      const pids = JSON.parse(await readFile(pidPath, "utf8")) as { parent: number; child: number };
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const parentAlive = (() => { try { process.kill(pids.parent, 0); return true; } catch { return false; } })();
        const childAlive = (() => { try { process.kill(pids.child, 0); return true; } catch { return false; } })();
        if (!parentAlive && !childAlive) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(() => process.kill(pids.parent, 0)).toThrow();
      expect(() => process.kill(pids.child, 0)).toThrow();
      await expect(access(pidPath)).resolves.toBeUndefined();
      expect(await listPublicationReceipts(root)).toHaveLength(0);
      expect((await listEvents(root, 100)).filter((event) => event.type === "publication.failed" && event.data?.intentId === target.id)).toHaveLength(1);
      expect(await listProjectLocks(root)).toEqual([]);
      expect(await readMachineMediaRuntimeSnapshot()).toEqual(expect.objectContaining({ activeWeight: 0, queueDepth: 0, recentTerminals: expect.arrayContaining([expect.objectContaining({ stage: "publication-register", status: "timed_out" })]) }));
    } finally {
      if (previousProbe === undefined) delete process.env.FFPROBE_PATH; else process.env.FFPROBE_PATH = previousProbe;
      if (previousTimeout === undefined) delete process.env.AI_CANVAS_FFPROBE_TIMEOUT_MS; else process.env.AI_CANVAS_FFPROBE_TIMEOUT_MS = previousTimeout;
      if (previousGrace === undefined) delete process.env.AI_CANVAS_MEDIA_TERMINATION_GRACE_MS; else process.env.AI_CANVAS_MEDIA_TERMINATION_GRACE_MS = previousGrace;
    }
  });

  it("并发预检同一路径时分配不同版本，且最终符号链接不能注册", async () => {
    const { root, output } = await fixture();
    const requestedPath = path.join(output, "并发结果.png");
    const [first, second] = await Promise.all([
      preflightPublication(root, { idempotencyKey: "publish-concurrent-file-001", requestedPath, kind: "raw-image", context: { purpose: "generation-output", jobId: "job-a" } }),
      preflightPublication(root, { idempotencyKey: "publish-concurrent-file-002", requestedPath, kind: "raw-image", context: { purpose: "generation-output", jobId: "job-b" } }),
    ]);
    expect(new Set([first.targetPath, second.targetPath]).size).toBe(2);
    expect([first.targetPath, second.targetPath]).toContain(requestedPath);
    expect([first.targetPath, second.targetPath]).toContain(path.join(output, "并发结果_v002.png"));

    const external = await mkdtemp(path.join(os.tmpdir(), "ai-canvas-publication-file-"));
    roots.push(external);
    const outsideFile = path.join(external, "outside.png");
    await sharp({ create: { width: 320, height: 320, channels: 3, background: "#222222" } }).png().toFile(outsideFile);
    await symlink(outsideFile, first.targetPath, "file");
    await expect(registerPublication(root, { intentId: first.id, reservationToken: first.reservationToken, expectedRevision: 1 })).rejects.toThrow("不能是目录或符号链接");
    expect((await getPublicationIntent(root, first.id))?.status).toBe("failed");
  });

  it("锁外 ffprobe 不阻塞无关预检，取消终态优先于旧校验结果", async () => {
    const { root, output } = await fixture();
    const intent = await preflightPublication(root, { idempotencyKey: "publish-unlocked-validation-001", requestedPath: path.join(output, "slow.mp4"), kind: "video", context: { purpose: "edit-render" } });
    await writeFile(intent.targetPath, Buffer.alloc(60_000, 3));
    const markerPath = path.join(root, "slow-probe-started");
    const gatePath = path.join(root, "slow-probe-release");
    const fakeProbe = path.join(root, "slow-ffprobe.mjs");
    await writeFile(fakeProbe, `#!/usr/bin/env node\nimport { existsSync, writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(markerPath)}, "started");\nconst timer=setInterval(()=>{if(!existsSync(${JSON.stringify(gatePath)}))return;clearInterval(timer);process.stdout.write(JSON.stringify({streams:[{codec_name:"h264",width:640,height:360}],format:{duration:"1"}}));process.exit(0);},10);\n`, "utf8");
    await chmod(fakeProbe, 0o755);
    const previousProbe = process.env.FFPROBE_PATH;
    process.env.FFPROBE_PATH = fakeProbe;
    try {
      const registering = registerPublication(root, { intentId: intent.id, reservationToken: intent.reservationToken, expectedRevision: intent.revision });
      await waitForPath(markerPath);
      const started = Date.now();
      const unrelated = await preflightPublication(root, { idempotencyKey: "publish-unlocked-validation-002", requestedPath: path.join(output, "unrelated.bin"), kind: "other", context: { purpose: "other" } });
      const cancelled = await cancelPublication(root, { intentId: intent.id, reservationToken: intent.reservationToken, expectedRevision: intent.revision, reason: "用户在机械校验期间取消" }, "user");
      expect(Date.now() - started).toBeLessThan(1_000);
      expect(unrelated.status).toBe("reserved");
      expect(cancelled.status).toBe("cancelled");
      await writeFile(gatePath, "release", "utf8");
      await expect(registering).rejects.toThrow(/cancelled|状态已变化|已更新/);
      expect((await getPublicationIntent(root, intent.id))?.status).toBe("cancelled");
      expect(await listPublicationReceipts(root)).toHaveLength(0);
      expect(await listProjectLocks(root)).toEqual([]);
      expect(await readMachineMediaRuntimeSnapshot()).toEqual(expect.objectContaining({ activeWeight: 0, queueDepth: 0 }));
    } finally {
      if (previousProbe === undefined) delete process.env.FFPROBE_PATH; else process.env.FFPROBE_PATH = previousProbe;
      await writeFile(gatePath, "release", "utf8").catch(() => undefined);
    }
  }, 30_000);

  it("两个校验快照并发注册同一意图时只生成一份回执", async () => {
    const { root, output } = await fixture();
    const intent = await preflightPublication(root, { idempotencyKey: "publish-same-intent-race-001", requestedPath: path.join(output, "same-intent.bin"), kind: "other", context: { purpose: "other" } });
    await writeFile(intent.targetPath, "same immutable payload", "utf8");
    let snapshots = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const options = { afterSnapshot: async () => { snapshots += 1; if (snapshots === 2) release(); await barrier; } };
    const input = { intentId: intent.id, reservationToken: intent.reservationToken, expectedRevision: intent.revision };
    const [first, second] = await Promise.all([
      registerPublication(root, input, "codex", options),
      registerPublication(root, input, "codex", options),
    ]);
    expect(first.id).toBe(second.id);
    expect(await listPublicationReceipts(root)).toHaveLength(1);
    expect((await listEvents(root, 100)).filter((event) => event.type === "publication.registered" && event.data?.intentId === intent.id)).toHaveLength(1);
  });

  it("锁外校验期间无关预检可提交，且不会用全局 store revision 误杀当前注册", async () => {
    const { root, output } = await fixture();
    const intent = await preflightPublication(root, { idempotencyKey: "publish-unrelated-preflight-001", requestedPath: path.join(output, "primary.bin"), kind: "other", context: { purpose: "other" } });
    await writeFile(intent.targetPath, "primary payload", "utf8");
    let validationFinished!: () => void;
    let releaseCommit!: () => void;
    const reachedCommit = new Promise<void>((resolve) => { validationFinished = resolve; });
    const commitGate = new Promise<void>((resolve) => { releaseCommit = resolve; });
    const registering = registerPublication(root, { intentId: intent.id, reservationToken: intent.reservationToken, expectedRevision: intent.revision }, "codex", {
      beforeCommit: async () => { validationFinished(); await commitGate; },
    });
    await reachedCommit;
    const unrelated = await preflightPublication(root, { idempotencyKey: "publish-unrelated-preflight-002", requestedPath: path.join(output, "secondary.bin"), kind: "other", context: { purpose: "other" } });
    releaseCommit();
    const receipt = await registering;
    expect(receipt.intentId).toBe(intent.id);
    expect(unrelated.status).toBe("reserved");
    expect((await getPublicationIntent(root, intent.id))?.status).toBe("registered");
  });

  it("提交前同尺寸同 mtime 原子替换会触发强文件 CAS，且保留预留供重试", async () => {
    const { root, output } = await fixture();
    const intent = await preflightPublication(root, { idempotencyKey: "publish-strong-file-cas-001", requestedPath: path.join(output, "strong-cas.bin"), kind: "other", context: { purpose: "other" } });
    await writeFile(intent.targetPath, "AAAA", "utf8");
    const before = await stat(intent.targetPath);
    const replacementPath = path.join(output, "replacement.tmp");
    await writeFile(replacementPath, "BBBB", "utf8");
    await utimes(replacementPath, before.atime, before.mtime);
    await expect(registerPublication(root, { intentId: intent.id, reservationToken: intent.reservationToken, expectedRevision: intent.revision }, "codex", {
      beforeCommit: async () => {
        await rename(replacementPath, intent.targetPath);
        await utimes(intent.targetPath, before.atime, before.mtime);
      },
    })).rejects.toThrow(/文件.*变化|CAS/);
    expect((await getPublicationIntent(root, intent.id))?.status).toBe("reserved");
    expect(await listPublicationReceipts(root)).toHaveLength(0);
    const receipt = await registerPublication(root, { intentId: intent.id, reservationToken: intent.reservationToken, expectedRevision: intent.revision });
    expect(receipt.check.sha256).toBe("4a8d8134f29b0b7b60c126f5532bc9f5d9bb73037373cf6fb872d81f1dcefdfd");
  });

  it("跨进程并发同一意图收敛到单回执，校验后崩溃则保持 reserved 可恢复", async () => {
    const { root, output } = await fixture();
    const concurrent = await preflightPublication(root, { idempotencyKey: "publish-cross-process-race-001", requestedPath: path.join(output, "cross-process.bin"), kind: "other", context: { purpose: "other" } });
    await writeFile(concurrent.targetPath, "cross process payload", "utf8");
    const args = [root, concurrent.id, concurrent.reservationToken, String(concurrent.revision), "normal"];
    const [first, second] = await Promise.all([
      execFileAsync(process.execPath, ["--import", "tsx", "scripts/publication-register-worker.ts", ...args], { cwd: process.cwd(), env: process.env }),
      execFileAsync(process.execPath, ["--import", "tsx", "scripts/publication-register-worker.ts", ...args], { cwd: process.cwd(), env: process.env }),
    ]);
    const receiptIds = [first.stdout, second.stdout].map((value) => (JSON.parse(value.trim()) as { receiptId: string }).receiptId);
    expect(new Set(receiptIds).size).toBe(1);
    expect(await listPublicationReceipts(root)).toHaveLength(1);

    const crashIntent = await preflightPublication(root, { idempotencyKey: "publish-crash-recovery-001", requestedPath: path.join(output, "crash-recovery.bin"), kind: "other", context: { purpose: "other" } });
    await writeFile(crashIntent.targetPath, "validated before crash", "utf8");
    const markerPath = path.join(root, "publication-before-commit.marker");
    const child = spawn(process.execPath, ["--import", "tsx", "scripts/publication-register-worker.ts", root, crashIntent.id, crashIntent.reservationToken, String(crashIntent.revision), "hold-before-commit", markerPath], { cwd: process.cwd(), env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    await waitForPath(markerPath);
    child.kill("SIGKILL");
    await new Promise<void>((resolve) => child.once("close", () => resolve()));
    expect((await getPublicationIntent(root, crashIntent.id))?.status).toBe("reserved");
    expect(await listProjectLocks(root)).toEqual([]);
    expect((await listPublicationReceipts(root)).some((receipt) => receipt.intentId === crashIntent.id)).toBe(false);
    const recovered = await registerPublication(root, { intentId: crashIntent.id, reservationToken: crashIntent.reservationToken, expectedRevision: crashIntent.revision });
    expect(recovered.intentId).toBe(crashIntent.id);
  }, 30_000);

  it("机械失败通过命令账本形成 confirmed failed，而不是永久 unknown", async () => {
    const { root, output } = await fixture();
    const intent = await preflightPublication(root, { idempotencyKey: "publish-command-failed-intent-001", requestedPath: path.join(output, "empty.bin"), kind: "other", context: { purpose: "other" } });
    await writeFile(intent.targetPath, "", "utf8");
    const input = {
      requestId: "request-publication-failed-001",
      idempotencyKey: "command-publication-failed-001",
      request: { command: "register_publication" as const, payload: { intentId: intent.id, reservationToken: intent.reservationToken, expectedRevision: intent.revision } },
    };
    await expect(executeIdempotentCommand(root, input)).rejects.toThrow("最终发布文件为空");
    expect((await listCommandLedger(root))[0]).toEqual(expect.objectContaining({ status: "failed", result: expect.objectContaining({ intentId: intent.id, status: "failed" }) }));
    expect((await reconcileCommand(root, { idempotencyKey: input.idempotencyKey })).status).toBe("failed");
    await expect(executeIdempotentCommand(root, { ...input, requestId: "request-publication-failed-002" })).rejects.toThrow("已明确失败");
  });

  it("真实 confirmed failure 在终态账本写失败后只用安全结构化投影恢复", async () => {
    const { root, output } = await fixture();
    const intent = await preflightPublication(root, { idempotencyKey: "publish-command-safe-failure-intent-001", requestedPath: path.join(output, "empty-safe.bin"), kind: "other", context: { purpose: "other" } });
    await writeFile(intent.targetPath, "", "utf8");
    const input = {
      requestId: "request-publication-safe-failure-001",
      idempotencyKey: "command-publication-safe-failure-001",
      request: { command: "register_publication" as const, payload: { intentId: intent.id, reservationToken: intent.reservationToken, expectedRevision: intent.revision } },
    };
    process.env.AI_CANVAS_TEST_COMMAND_FAIL_TERMINAL_LEDGER_ONCE = input.request.command;
    await expect(executeIdempotentCommand(root, input)).rejects.toMatchObject({
      code: "OUTCOME_UNKNOWN",
      reconciliationRequired: true,
    });
    delete process.env.AI_CANVAS_TEST_COMMAND_FAIL_TERMINAL_LEDGER_ONCE;

    const terminal = (await listEvents(root, 200)).find((event) =>
      event.type === "command.side-effect-committed" && event.idempotencyKey === input.idempotencyKey);
    expect(terminal?.data?.result).toEqual(expect.objectContaining({
      schemaVersion: 1,
      kind: "confirmed-command-failure",
      code: "confirmed_failure",
      intentId: intent.id,
      status: "failed",
    }));
    expect(JSON.stringify(terminal?.data)).not.toContain(intent.targetPath);
    const reconciled = await reconcileCommand(root, { idempotencyKey: input.idempotencyKey });
    expect(reconciled).toMatchObject({
      status: "failed",
      result: { schemaVersion: 1, kind: "confirmed-command-failure", intentId: intent.id, status: "failed" },
    });
    await expect(executeIdempotentCommand(root, { ...input, requestId: "request-publication-safe-failure-002" }))
      .rejects.toMatchObject({
        name: "ConfirmedCommandFailure",
        result: { schemaVersion: 1, kind: "confirmed-command-failure", intentId: intent.id, status: "failed" },
      });
  });

  it("发布写操作通过命令账本继承外层幂等键并可安全重放", async () => {
    const { root, output } = await fixture();
    const preflightInput = {
      requestId: "request-publication-preflight-001",
      idempotencyKey: "command-publication-preflight-001",
      request: { command: "preflight_publication" as const, payload: { requestedPath: path.join(output, "ledger.bin"), kind: "other" as const, context: { purpose: "other" as const } } },
    };
    const preflight = await executeIdempotentCommand(root, preflightInput);
    const intent = preflight.result as PublicationIntent;
    expect(intent.status).toBe("reserved");
    expect((await executeIdempotentCommand(root, preflightInput)).replayed).toBe(true);
    await writeFile(intent.targetPath, "registered through command ledger", "utf8");
    const registered = await executeIdempotentCommand(root, {
      requestId: "request-publication-register-001",
      idempotencyKey: "command-publication-register-001",
      request: { command: "register_publication", payload: { intentId: intent.id, reservationToken: intent.reservationToken, expectedRevision: intent.revision } },
    });
    const receipt = registered.result as PublicationReceipt;
    expect(receipt.intentId).toBe(intent.id);
    expect(receipt.check.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect((await getPublicationIntent(root, intent.id))?.status).toBe("registered");
  });
});
