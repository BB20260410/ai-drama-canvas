import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertAttestation,
  assertVisualReview,
  finalizeRealImagegenCanary,
  prepareRealImagegenCanary,
  type AgentImagegenSessionAttestation,
  type AgentImagegenVisualReview,
  type RealImagegenCanaryEnvelope,
} from "../scripts/run-real-imagegen-canary-v2.js";

const cleanupRoots: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function sha(filePath: string): Promise<string> {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right, "en"))
    .map(([key, entry]) => [key, stable(entry)]));
}

function resealEnvelope(envelope: RealImagegenCanaryEnvelope): RealImagegenCanaryEnvelope {
  const { fingerprint: _fingerprint, ...body } = envelope;
  return {
    ...body,
    fingerprint: createHash("sha256").update(JSON.stringify(stable(body)), "utf8").digest("hex"),
  };
}

async function prepare(provider: "codex" | "grok" = "codex") {
  const root = await mkdtemp(path.join(os.tmpdir(), "real-canary-v2-test-"));
  cleanupRoots.push(root);
  const envelopePath = path.join(root, "envelope.json");
  const envelope = await prepareRealImagegenCanary({ provider, envelopePath, ttlMinutes: 10 });
  cleanupRoots.push(envelope.runtime.ownerRoot);
  const rawPath = path.join(root, "generated.jpg");
  await sharp({ create: { width: 720, height: 1280, channels: 3, background: { r: 44, g: 68, b: 82 } } }).jpeg({ quality: 88 }).toFile(rawPath);
  const rawSha256 = await sha(rawPath);
  return { root, envelopePath, envelope, rawPath, rawSha256 };
}

function attestation(envelope: RealImagegenCanaryEnvelope, rawSha256: string): AgentImagegenSessionAttestation {
  return {
    schemaVersion: 1,
    kind: "agent-imagegen-session-attestation",
    attestationLevel: "agent-session-direct",
    provider: envelope.provider,
    executorKind: "agent-imagegen",
    primaryTool: "image_gen",
    generationRunId: envelope.generationRunId,
    packFingerprint: envelope.pack.packFingerprint,
    promptSha256: envelope.pack.promptSha256,
    rawSha256,
    directToolCall: true,
    formalImageGenerationCalls: 1,
    agentTaskName: "/root/test-agent",
    createdAt: new Date().toISOString(),
    note: "测试中模拟当前 Agent 会话直接调用；不得作为正式供应商证明。",
  };
}

function visualReview(
  envelope: RealImagegenCanaryEnvelope,
  rawSha256: string,
  decision: "pass" | "rework" = "pass",
): AgentImagegenVisualReview {
  return {
    schemaVersion: 1,
    kind: "agent-imagegen-visual-review",
    scope: "synthetic-canary-contract",
    rawSha256,
    packFingerprint: envelope.pack.packFingerprint,
    decision,
    reviewer: "/root/test-visual-reviewer",
    reviewedAt: new Date().toISOString(),
    note: decision === "pass" ? "合成 canary 合同视觉通过。" : "画面质量不合格，登记返工。",
    criteria: [
      { code: "prompt-contract", status: "pass", note: "单图合同" },
      { code: "prop-scene-consistency", status: "pass", note: "测试范围" },
      { code: "forbidden-content", status: "pass", note: "无禁项" },
      { code: "image-quality", status: decision === "pass" ? "pass" : "fail", note: decision === "pass" ? "可解码" : "颜色占位" },
    ],
  };
}

describe("真实 agent-imagegen canary v2", () => {
  it("provider/pack/prompt/raw 任一漂移均失败关闭", async () => {
    const current = await prepare("codex");
    const valid = attestation(current.envelope, current.rawSha256);
    expect(() => assertAttestation({ ...valid, provider: "grok" }, current.envelope, current.rawSha256)).toThrow("provider/tool");
    expect(() => assertAttestation({ ...valid, packFingerprint: "0".repeat(64) }, current.envelope, current.rawSha256)).toThrow("packFingerprint");
    expect(() => assertAttestation({ ...valid, promptSha256: "1".repeat(64) }, current.envelope, current.rawSha256)).toThrow("promptSha256");
    expect(() => assertAttestation({ ...valid, rawSha256: "2".repeat(64) }, current.envelope, current.rawSha256)).toThrow("rawSha256");
  });

  it("视觉 pass 缺必需项或包含 fail 时拒绝提升", async () => {
    const current = await prepare();
    const valid = visualReview(current.envelope, current.rawSha256);
    expect(() => assertVisualReview({ ...valid, criteria: valid.criteria.filter((entry) => entry.code !== "image-quality") }, current.envelope, current.rawSha256)).toThrow("缺少必需");
    expect(() => assertVisualReview({ ...valid, criteria: valid.criteria.map((entry) => entry.code === "image-quality" ? { ...entry, status: "fail" as const } : entry) }, current.envelope, current.rawSha256)).toThrow("必须 pass");
  });

  it("缺少独立 attestation/review 文件时 finalize 失败且不伪装 pass", async () => {
    const current = await prepare();
    await expect(finalizeRealImagegenCanary({
      envelopePath: current.envelopePath,
      rawPath: current.rawPath,
      attestationPath: path.join(current.root, "missing-attestation.json"),
      visualReviewPath: path.join(current.root, "missing-review.json"),
      evidencePath: path.join(current.root, "evidence.json"),
    })).rejects.toThrow();
    await expect(access(path.join(current.root, "evidence.json"))).rejects.toThrow();
  });

  it("重算普通 fingerprint 也不能把 finalize 的递归清理改绑到伪造临时根", async () => {
    const current = await prepare();
    const victim = await mkdtemp(path.join(os.tmpdir(), "real-canary-v2-victim-"));
    cleanupRoots.push(victim);
    const forgedParent = path.join(victim, "parent");
    const forgedProject = path.join(forgedParent, "project");
    await mkdir(forgedProject, { recursive: true });
    const keepPath = path.join(victim, "keep.txt");
    await writeFile(keepPath, "must-survive");
    const forged = resealEnvelope({
      ...current.envelope,
      runtime: {
        ownerRoot: victim,
        ownerLeaseId: "11111111-1111-1111-1111-111111111111",
        parentRoot: forgedParent,
        projectRoot: forgedProject,
      },
    });
    const forgedPath = path.join(current.root, "forged-envelope.json");
    await writeFile(forgedPath, `${JSON.stringify(forged, null, 2)}\n`);

    await expect(finalizeRealImagegenCanary({
      envelopePath: forgedPath,
      rawPath: current.rawPath,
      attestationPath: path.join(current.root, "missing-attestation.json"),
      visualReviewPath: path.join(current.root, "missing-review.json"),
      evidencePath: path.join(current.root, "forged-evidence.json"),
    })).rejects.toThrow(/owner marker/u);
    expect(await readFile(keepPath, "utf8")).toBe("must-survive");
  });

  it("完整 pass 链保留格式正确的 raw+labeled 和两份审计输入", async () => {
    const current = await prepare("codex");
    const attestationPath = path.join(current.root, "attestation.json");
    const reviewPath = path.join(current.root, "review.json");
    const evidencePath = path.join(current.root, "evidence.json");
    await writeFile(attestationPath, `${JSON.stringify(attestation(current.envelope, current.rawSha256), null, 2)}\n`);
    await writeFile(reviewPath, `${JSON.stringify(visualReview(current.envelope, current.rawSha256), null, 2)}\n`);
    const result = await finalizeRealImagegenCanary({
      envelopePath: current.envelopePath,
      rawPath: current.rawPath,
      attestationPath,
      visualReviewPath: reviewPath,
      evidencePath,
    });
    expect(result).toMatchObject({
      status: "pass",
      provider: "codex",
      providerProvenance: { level: "agent-session-direct", cryptographicProviderReceipt: false },
      visualReview: { scope: "synthetic-canary-contract", productionContinuityPassed: false },
    });
    await expect(access(path.join(current.root, "evidence-raw.jpg"))).resolves.toBeUndefined();
    await expect(access(path.join(current.root, "evidence-labeled.png"))).resolves.toBeUndefined();
    await expect(access(path.join(current.root, "evidence-attestation.json"))).resolves.toBeUndefined();
    await expect(access(path.join(current.root, "evidence-visual-review.json"))).resolves.toBeUndefined();
    await expect(access(current.envelope.runtime.ownerRoot)).rejects.toThrow();
  });

  it("视觉 rework 会写入 Review 但不会产生 approved raw", async () => {
    const current = await prepare("grok");
    const attestationPath = path.join(current.root, "attestation.json");
    const reviewPath = path.join(current.root, "review.json");
    const evidencePath = path.join(current.root, "evidence.json");
    await writeFile(attestationPath, JSON.stringify(attestation(current.envelope, current.rawSha256)));
    await writeFile(reviewPath, JSON.stringify(visualReview(current.envelope, current.rawSha256, "rework")));
    const result = await finalizeRealImagegenCanary({
      envelopePath: current.envelopePath,
      rawPath: current.rawPath,
      attestationPath,
      visualReviewPath: reviewPath,
      evidencePath,
    });
    expect(result).toMatchObject({ status: "rework", review: { decision: "rework", approvedRawEligible: false } });
  });
});
