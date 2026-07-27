/**
 * 包内已有图 → Studio 账本（禁止模型重出）。
 *
 * 流程：readiness/freeze → dispatch(provider=grok 仅作执行面声明) →
 * import 包内 jpg → register raw/labeled → 可选 review。
 *
 * 像素源优先级见 .aicanvas/GENERATION_POLICY.md
 */
import { mkdir, writeFile, access, copyFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { executeIdempotentCommand } from "../src/core/command-bus.js";
import { getStudioGenerationControlEnvelope } from "../src/core/codex.js";
import { importStudioMedia } from "../src/core/material-studio.js";
import { getStudioProductionDashboard } from "../src/core/studio-production-dashboard.js";
import { getStudioProductionUnitSnapshot } from "../src/core/studio-production.js";

const PROJECT =
  "/Users/hxx/Documents/无限画布/projects/codex-ai-drama-studio";
const PKG =
  "/Users/hxx/Documents/小说第一季/第一季_视觉资产锁定与15秒宫格故事版_20260718";
const TAG = "s1-pkg-register-v2";
const OUT = path.join(PROJECT, ".aicanvas", "package-register-out");

async function exec(step: string, command: string, payload: Record<string, unknown>) {
  const r = await executeIdempotentCommand(PROJECT, {
    requestId: `${TAG}:${step}`,
    idempotencyKey: `${TAG}:${step}`,
    request: { command, payload } as any,
  });
  if (r.status !== "succeeded") {
    throw new Error(`${command} ${r.status}: ${JSON.stringify(r.error)} [${step}]`);
  }
  return r.result as any;
}

function unitKeyFromStudioId(unitId: string): { ep: string; key: string } {
  // unit-ep01_15s_001 → EP01, EP01_15s_001
  const m = unitId.match(/unit-(ep\d+)_15s_(\d+)/i);
  if (!m) throw new Error(`bad unitId ${unitId}`);
  const ep = m[1]!.toUpperCase();
  const seq = m[2]!.padStart(3, "0");
  return { ep, key: `${ep}_15s_${seq}` };
}

function panelIndex(panelId: string): number {
  const m = panelId.match(/panel-0?(\d+)/i);
  if (!m) throw new Error(`bad panelId ${panelId}`);
  return Number(m[1]);
}

/** 解析包内 raw 路径；禁止调用任何生图模型。 */
export function resolvePackagePanelRawPath(unitId: string, panelId: string): {
  rawPath: string;
  source: string;
  labeledPath?: string;
} {
  const { ep, key } = unitKeyFromStudioId(unitId);
  const idx = panelIndex(panelId);
  const pad = String(idx).padStart(2, "0");

  const candidates: Array<{ path: string; source: string }> = [
    {
      path: path.join(PKG, "09_单元成片", ep, key, `i2v_panel_${pad}.jpg`),
      source: "09_i2v_panel",
    },
    {
      path: path.join(PKG, "09_单元成片", ep, key, `i2v_panel_${pad}.png`),
      source: "09_i2v_panel",
    },
  ];

  // 样板 panels 目录（仅 001 等）
  const sampleDir = path.join(
    PKG,
    "10_验证成品_宫格故事版样板",
  );
  if (existsSync(sampleDir)) {
    // 模糊匹配 key
    // EP01_15s_001_雾河神落/panels/01_*.jpg
  }

  for (const c of candidates) {
    if (existsSync(c.path)) {
      return { rawPath: c.path, source: c.source };
    }
  }

  // 样板：遍历 10
  try {
    const { readdirSync } = require("node:fs") as typeof import("node:fs");
    for (const name of readdirSync(path.join(PKG, "10_验证成品_宫格故事版样板"))) {
      if (!name.startsWith(key)) continue;
      const panelsDir = path.join(PKG, "10_验证成品_宫格故事版样板", name, "panels");
      if (!existsSync(panelsDir)) continue;
      const files = readdirSync(panelsDir).filter((f) =>
        f.startsWith(`${pad}_`) || f.startsWith(`0${idx}_`) || f.match(new RegExp(`^0?${idx}_`)),
      );
      if (files[0]) {
        return {
          rawPath: path.join(panelsDir, files[0]),
          source: "10_sample_panels",
        };
      }
    }
  } catch {
    /* ignore */
  }

  // 从 04 raw 宫格板裁切（机械，非模型）
  const epDir = path.join(PKG, "04_15秒宫格故事版", ep);
  if (existsSync(epDir)) {
    const { readdirSync } = require("node:fs") as typeof import("node:fs");
    const unitDir = readdirSync(epDir).find((d) => d.startsWith(`${key}_`));
    if (unitDir) {
      const rawBoard = path.join(epDir, unitDir, `${unitDir}_raw.jpg`);
      // 文件名可能是 EP01_15s_001_雾河神落_raw.jpg
      const alt = readdirSync(path.join(epDir, unitDir)).find((f) => f.endsWith("_raw.jpg"));
      const board = existsSync(rawBoard)
        ? rawBoard
        : alt
          ? path.join(epDir, unitDir, alt)
          : "";
      if (board && existsSync(board)) {
        return {
          rawPath: board,
          source: "04_raw_board_needs_crop",
        };
      }
    }
  }

  throw new Error(
    `包内无可用像素：${unitId}/${panelId}。已查 09 i2v_panel、10 panels、04 raw。禁止模型重出。`,
  );
}

async function cropIfBoard(
  resolved: { rawPath: string; source: string },
  panelId: string,
  outPath: string,
): Promise<string> {
  if (resolved.source !== "04_raw_board_needs_crop") {
    return resolved.rawPath;
  }
  const { createRequire } = await import("node:module");
  // use sharp if available via project
  const sharp = (await import("sharp")).default;
  const idx = panelIndex(panelId); // 1..6
  const col = (idx - 1) % 3;
  const row = Math.floor((idx - 1) / 3);
  const meta = await sharp(resolved.rawPath).metadata();
  const w = meta.width!;
  const h = meta.height!;
  const cw = Math.floor(w / 3);
  const ch = Math.floor(h / 2);
  await sharp(resolved.rawPath)
    .extract({ left: col * cw, top: row * ch, width: cw, height: ch })
    .jpeg({ quality: 92 })
    .toFile(outPath);
  return outPath;
}

async function makeLabeled(rawPath: string, outPath: string, title: string) {
  const sharp = (await import("sharp")).default;
  const meta = await sharp(rawPath).metadata();
  const w = meta.width!;
  const h = meta.height!;
  const bar = Math.max(64, Math.floor(h / 10));
  const svg = Buffer.from(
    `<svg width="${w}" height="${bar}"><rect width="100%" height="100%" fill="#121216"/>
    <text x="20" y="${Math.floor(bar * 0.55)}" fill="#e6e6eb" font-size="${Math.max(16, Math.floor(bar / 3))}" font-family="sans-serif">${title.replace(/[<>&]/g, "")}</text></svg>`,
  );
  await sharp(rawPath)
    .extend({ bottom: bar, background: { r: 18, g: 18, b: 22 } })
    .composite([{ input: svg, top: h, left: 0 }])
    .jpeg({ quality: 90 })
    .toFile(outPath);
}

async function main() {
  const unitId = process.argv[2] || "unit-ep01_15s_001";
  const panelId = process.argv[3] || "panel-02";
  const doReview = process.argv.includes("--review-pass");
  await mkdir(OUT, { recursive: true });

  const unitDash = await getStudioProductionDashboard(PROJECT, {
    operation: "unit",
    unitId,
  });
  console.log("unit nextAction", unitDash.nextAction?.code, unitDash.nextAction?.reason);

  const resolved = resolvePackagePanelRawPath(unitId, panelId);
  console.log("package source", resolved);

  const cropOut = path.join(OUT, `${unitId}-${panelId}-raw.jpg`);
  const rawPath = await cropIfBoard(resolved, panelId, cropOut);
  if (rawPath !== cropOut && resolved.source !== "04_raw_board_needs_crop") {
    await copyFile(rawPath, cropOut);
  }
  const finalRaw = existsSync(cropOut) ? cropOut : rawPath;

  const labeledOut = path.join(OUT, `${unitId}-${panelId}-labeled.jpg`);
  await makeLabeled(
    finalRaw,
    labeledOut,
    `${unitId} ${panelId} · package:${resolved.source} · no-regen`,
  );

  // 必须先 freeze 落账（readiness.candidate 可能只是预计算指纹，尚未持久）
  const snap = await getStudioProductionUnitSnapshot(PROJECT, unitId);
  if (!snap) throw new Error("no snapshot");
  const unitRevision = snap.unit.revision;
  const frozen = await exec(`freeze:${unitId}:${panelId}`, "freeze_studio_generation_pack", {
    unitId,
    panelId,
    expectedRevision: unitRevision,
  });
  const packId = (frozen.packId || frozen.pack?.id) as string;
  const packFingerprint = (frozen.fingerprint || frozen.pack?.fingerprint) as string;
  if (!packId || !packFingerprint) {
    throw new Error(`freeze 未返回 packId/fingerprint: ${JSON.stringify(frozen).slice(0, 400)}`);
  }
  console.log("frozen", packId, packFingerprint.slice(0, 16));

  const runId = `pkg-register-${unitId}-${panelId}-v1`;

  await exec(`dispatch:${unitId}:${panelId}`, "dispatch_studio_generation_pack", {
    packId,
    packFingerprint,
    generationRunId: runId,
    provider: "grok",
    expectedRevision: unitRevision,
  });

  const rawMedia = await importStudioMedia(PROJECT, {
    sourcePath: path.resolve(finalRaw),
    kind: "image",
  });
  const labeledMedia = await importStudioMedia(PROJECT, {
    sourcePath: path.resolve(labeledOut),
    kind: "image",
  });

  const rawReg = await exec(`reg-raw:${unitId}:${panelId}`, "register_studio_generation_result", {
    packId,
    packFingerprint,
    generationRunId: runId,
    variant: "raw",
    mediaSha256: rawMedia.sha256,
    provider: "grok",
    expectedRevision: unitRevision,
  });
  const labeledReg = await exec(`reg-lab:${unitId}:${panelId}`, "register_studio_generation_result", {
    packId,
    packFingerprint,
    generationRunId: runId,
    variant: "labeled",
    mediaSha256: labeledMedia.sha256,
    provider: "grok",
    expectedRevision: unitRevision,
  });

  let review: unknown = null;
  if (doReview) {
    const packEnv = await getStudioGenerationControlEnvelope(PROJECT, {
      operation: "pack",
      packId,
    } as any);
    const continuityFingerprint = (packEnv as any).pack.continuity.fingerprint;
    review = await exec(`review:${unitId}:${panelId}`, "submit_studio_generation_review", {
      generationRunId: runId,
      kind: "observation",
      expectedHeadRevision: 0,
      rawResultId: rawReg.resultId,
      rawSha256: rawMedia.sha256,
      labeledResultId: labeledReg.resultId,
      labeledSha256: labeledMedia.sha256,
      expectedPackFingerprint: packFingerprint,
      continuityFingerprint,
      decision: "pass",
      criteria: [
        {
          code: "package-pixel",
          status: "pass",
          note: `包内已有图登记 source=${resolved.source}，未模型重出。`,
        },
        {
          code: "raw-labeled-pair",
          status: "pass",
          note: "raw/labeled 成对。",
        },
      ],
      reviewer: "codex",
      note: `package-register-only ${resolved.source} ${finalRaw}`,
    });
  }

  const after = await getStudioProductionDashboard(PROJECT, {
    operation: "unit",
    unitId,
  });
  const report = {
    policy: "package-first-no-regen",
    unitId,
    panelId,
    source: resolved,
    rawPath: finalRaw,
    packId,
    runId,
    rawSha: rawMedia.sha256,
    labeledSha: labeledMedia.sha256,
    review: doReview ? "submitted" : "skipped",
    unitNext: after.nextAction,
  };
  await writeFile(
    path.join(OUT, `report-${unitId}-${panelId}.json`),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
