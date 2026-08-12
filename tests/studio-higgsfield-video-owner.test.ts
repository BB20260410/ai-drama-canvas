import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  executeIdempotentCommand,
  projectHiggsfieldConnectorQueueResultForPersistence,
  projectHiggsfieldPrepareResultForPersistence,
} from "../src/core/command-bus.js";
import { compileStudioHiggsfieldConnectorPrompt, sanitizeHiggsfieldRemoteObservation } from "../src/core/studio-higgsfield-video-generation.js";
import { projectHiggsfieldPrepareConnectorRequestForMcp } from "../src/core/studio-higgsfield-mcp-projection.js";
import { STUDIO_WRITE_LEASE_ENFORCED_COMMANDS } from "../src/core/studio-project-write-lease.js";

const sha = "a".repeat(64);
const root = "/private/tmp/higgsfield-project";
const localPath = `${root}/.aicanvas/studio-video-package-source-closure/objects/sha256/aa/${sha}`;
const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("Higgsfield 视频 owner 边界", () => {
  it("按 managed panels 的时间顺序编译 positivePrompt，并锁住 15–20 秒尾态", () => {
    expect(compileStudioHiggsfieldConnectorPrompt(Buffer.from(JSON.stringify({ panels: [
      { order: 2, timecode: { unitStartSeconds: 8, unitEndSeconds: 15 }, positivePrompt: "人物停步" },
      { order: 1, timecode: { unitStartSeconds: 0, unitEndSeconds: 8 }, positivePrompt: "人物入画" },
    ] })))).toBe("【0–8s】人物入画\n【8–15s】人物停步\n【15–20s】保持第15秒末态，不新增叙事事件。");
    expect(() => compileStudioHiggsfieldConnectorPrompt(Buffer.from('{"panels":[{}]}'))).toThrow(/positivePrompt/u);
  });

  it("prepare MCP 只保留严格 source-closure CAS 图片路径，越界路径拒绝而非通用清洗丢失", () => {
    const projected = projectHiggsfieldPrepareConnectorRequestForMcp({ connectorRequest: { imageReferences: [{ order: 1, sha256: sha, localPath }] } }, root) as any;
    expect(projected.connectorRequest.imageReferences[0].localPath).toBe(localPath);
    expect(() => projectHiggsfieldPrepareConnectorRequestForMcp({ connectorRequest: { imageReferences: [{ order: 1, sha256: sha, localPath: "/tmp/escape.png" }] } }, root)).toThrow(/以外/u);
  });

  it("持久账本撤销一次性许可并删除含绝对路径的 connectorRequest", () => {
    const persisted = projectHiggsfieldPrepareResultForPersistence({
      callAllowed: true,
      replayed: false,
      connectorRequest: { imageReferences: [{ order: 1, sha256: sha, localPath }] },
    }) as Record<string, unknown>;
    expect(persisted).toMatchObject({ callAllowed: false, idempotentReplay: true });
    expect(persisted).not.toHaveProperty("connectorRequest");
    expect(JSON.stringify(persisted)).not.toContain(localPath);
  });

  it("claim/authorize 的一次性 token 与受控路径不会进入可重放结果", () => {
    const claim = projectHiggsfieldConnectorQueueResultForPersistence("claim_studio_higgsfield_connector_request", { claimToken: "higgsclaim-secret", requestId: "req" }) as Record<string, unknown>;
    const authorize = projectHiggsfieldConnectorQueueResultForPersistence("authorize_studio_higgsfield_connector_request", {
      submissionNonce: "higgsnonce-secret", callAllowed: true, connectorRequest: { imageReferences: [{ order: 1, sha256: sha, localPath }] }, requestId: "req",
    }) as Record<string, unknown>;
    expect(JSON.stringify({ claim, authorize })).not.toMatch(/higgsclaim-secret|higgsnonce-secret|\/private\/tmp/u);
    expect(authorize).toMatchObject({ callAllowed: false });
  });

  it("图片调用闭包不会递归 safetyConstraints 或 forbidden assets", async () => {
    const source = await readFile(path.join(workspaceRoot, "src/core/studio-command-executor.ts"), "utf8");
    expect(source).not.toContain("collectMediaSha(pack.request)");
    expect(source).toContain('filter((asset) => asset.presence !== "forbidden")');
    expect(source).toContain('resolution: "1k", quality: "low", count: 1, useUnlim: true');
  });

  it("旧 connector 执行命令对任何 actor 都在工程或命令账本 I/O 前失败关闭", async () => {
    await expect(executeIdempotentCommand("/definitely/not/a/managed/project", {
      requestId: "higgsfield-actor-guard-001",
      idempotencyKey: "higgsfield-actor-guard-key-001",
      request: {
        command: "prepare_studio_higgsfield_video_generation",
        payload: {
          intentId: "video-intent-123",
          expectedVideoPackageControlFingerprint: sha,
          projectContextToken: `studioctx-v1-${sha}`,
        },
      },
    }, { studioWriteActor: "user" })).rejects.toThrow(/已停用|受信任/u);
  });

  it("远端状态与 adjustments 脱敏但不阻断 unknown 对账", () => {
    const output = sanitizeHiggsfieldRemoteObservation(
      "password=abc; Authorization: Basic xyz; credential=foo; signature=bar; https://x.test/a?token=abc Bearer xyz me@example.com",
    );
    expect(output).toContain("[redacted-url]");
    expect(output).not.toMatch(/abc|Basic|xyz|foo|bar|example\.com|token=/u);
  });

  it("能力证明与 prepare/record 共用 Studio 写租约", () => {
    expect(STUDIO_WRITE_LEASE_ENFORCED_COMMANDS.has("attest_studio_higgsfield_connector_capability")).toBe(true);
    expect(STUDIO_WRITE_LEASE_ENFORCED_COMMANDS.has("prepare_studio_higgsfield_video_generation")).toBe(true);
    expect(STUDIO_WRITE_LEASE_ENFORCED_COMMANDS.has("record_studio_higgsfield_video_submission")).toBe(true);
  });

  it("画布明确只允许本地排队，受信任适配器落地前不能领取或调用", async () => {
    const source = await readFile(path.join(workspaceRoot, "src/renderer/src/components/HiggsfieldSeedanceVideoStep.vue"), "utf8");
    expect(source).toContain("受信任 connector 适配器落地前不能领取或调用");
    expect(source).not.toContain("Unlimited capability 已由 connector 明确确认");
  });
});
