/**
 * 真实 Grok/Codex agent-imagegen 最小 canary（隔离 /tmp 工程）。
 *
 * 流程：冻结包 → dispatch(provider) → 导入真生图 → register raw/labeled → Review
 * → 二次 dashboard 读（模拟重启）→ 证据 JSON。
 *
 * 用法：
 *   npx tsx scripts/run-real-imagegen-canary.ts \
 *     --provider grok \
 *     --raw /path/to/real-decoded.png \
 *     [output.json]
 *
 * 约束：
 * - 禁止 fixture 像素冒充真实生图；--raw 必须是外部真生图（可解码 PNG/JPEG）。
 * - labeled 由本地 sharp 在 raw 上叠中文格标（产品合同：raw 单图、宫格板本地排版）。
 * - 无 --raw 时写 status=blocked 证据并 exit 2（不伪装 pass）。
 * - 不触碰 projects/codex-ai-drama-studio；不 Git；不付费 API key 探测外站。
 */
import { createHash } from "node:crypto";
import { access, copyFile, mkdir, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import {
  createStudioP7Fixture,
  seedStudioP7ResolvedContinuity,
} from "../tests/helpers/studio-p7-fixture.js";
import { createBuildIdentity } from "../src/core/build-identity.js";
import { importStudioMedia, verifyStudioMediaObject } from "../src/core/material-studio.js";
import {
  dispatchStudioGenerationPack,
  freezeAndPersistStudioGenerationPack,
  registerStudioGenerationResult,
} from "../src/core/studio-generation-ledger.js";
import { submitStudioGenerationReview } from "../src/core/studio-generation-review.js";
import { buildStudioAgentImagegenBrief } from "../src/core/studio-generation.js";
import { getStudioProductionDashboard } from "../src/core/studio-production-dashboard.js";
import {
  formatStudioPanelTitle,
  materializeStudioLabeledLayout,
} from "../src/core/studio-labeled-layout.js";

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const evidenceRoot = path.join(workspace, "docs", "evidence");
const stamp = new Date().toISOString().replace(/[:.]/gu, "-").slice(0, 19);

function parseArgs(argv: string[]) {
  let provider: "codex" | "grok" = "grok";
  let rawPath: string | undefined;
  let outputPath: string | undefined;
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--provider") {
      const value = argv[++i];
      if (value !== "codex" && value !== "grok") {
        throw new Error(`--provider 必须是 codex|grok，收到：${value}`);
      }
      provider = value;
    } else if (arg === "--raw") {
      rawPath = argv[++i];
      if (!rawPath) throw new Error("--raw 需要路径");
    } else if (arg === "--help" || arg === "-h") {
      console.log(`Usage: npx tsx scripts/run-real-imagegen-canary.ts --provider grok|codex --raw <image> [output.json]`);
      process.exit(0);
    } else {
      rest.push(arg);
    }
  }
  outputPath = path.resolve(
    rest[0] || path.join(evidenceRoot, `real-imagegen-canary-20260718-${provider}.json`),
  );
  return { provider, rawPath, outputPath };
}

async function sha256File(filePath: string): Promise<string> {
  const { createReadStream } = await import("node:fs");
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve());
  });
  return hash.digest("hex");
}

async function assertDecodableImage(filePath: string): Promise<{
  width: number;
  height: number;
  format: string;
  sizeBytes: number;
  sha256: string;
}> {
  const info = await stat(filePath);
  if (!info.isFile() || info.size < 256) {
    throw new Error(`图像过小或不是文件：${filePath} (${info.size} bytes)`);
  }
  const meta = await sharp(filePath).metadata();
  if (!meta.width || !meta.height || !meta.format) {
    throw new Error(`无法解码图像：${filePath}`);
  }
  if (!["png", "jpeg", "webp", "jpg"].includes(meta.format === "jpeg" ? "jpeg" : meta.format)) {
    throw new Error(`不支持的图像格式：${meta.format}`);
  }
  // 拒绝纯色极小 fixture（48×72 一类）冒充生产生图
  if (meta.width < 256 || meta.height < 256) {
    throw new Error(`拒绝过小图像（疑似 fixture）：${meta.width}x${meta.height}`);
  }
  const sha256 = await sha256File(filePath);
  return {
    width: meta.width,
    height: meta.height,
    format: meta.format,
    sizeBytes: info.size,
    sha256,
  };
}

async function writeBlockedEvidence(
  outputPath: string,
  reason: string,
  provider: "codex" | "grok",
  extra: Record<string, unknown> = {},
) {
  const identity = await createBuildIdentity(workspace);
  const evidence = {
    schemaVersion: 1,
    kind: "real-imagegen-canary",
    status: "blocked",
    createdAt: new Date().toISOString(),
    provider,
    blockedReason: reason,
    buildIdentity: {
      buildId: identity.buildId,
      sourceDigest: identity.sourceDigest,
      fingerprint: identity.fingerprint,
    },
    boundaries: {
      realImagegenCanary: false,
      fixtureMediaUsedAsGenerated: false,
      formalProjectTouched: false,
      browserSupplierCalls: 0,
      gitStage: 0,
    },
    ...extra,
  };
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  console.error(JSON.stringify({ ok: false, status: "blocked", reason, outputPath }, null, 2));
  process.exitCode = 2;
}

async function main() {
  console.error([
    "旧版真实 imagegen canary 已永久停用：它缺少 prepare 后 dispatch、会话级单次调用证明与独立视觉审片门禁。",
    "请改用 scripts/run-real-imagegen-canary-v2.ts 的 --prepare / --finalize 两阶段流程。",
  ].join("\n"));
  process.exitCode = 2;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
