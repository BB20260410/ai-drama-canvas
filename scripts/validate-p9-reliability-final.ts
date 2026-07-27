/**
 * P9-R final-validation：写新证据文件，不覆盖历史 final。
 */
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { access, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expectedPanelCountForUnits, P9_SCALE_UNIT_COUNT, P9_SCALE_ASSET_COUNT } from "../src/core/studio-scale-fixture.js";
import { createBuildIdentity } from "../src/core/build-identity.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const workspace = await realpath(path.resolve(process.argv[2] ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")));
const evidenceRoot = path.join(workspace, "docs", "evidence");
const stamp = "20260718-p9r";
const outputPath = path.resolve(process.argv[3] ?? path.join(evidenceRoot, `final-validation-${stamp}-reliability.json`));
const runRoot = path.resolve(process.argv[4] ?? path.join(evidenceRoot, "runs", `p9r-reliability-final-${stamp}`));
const scaleEvidencePath = path.join(evidenceRoot, "p9-scale-fixture-20260718-p9r-full1288.json");
const mediaScalePath = path.join(evidenceRoot, "p9-media-scale-20260718-p9r.json");

await access(outputPath).then(
  () => { throw new Error(`final 已存在：${outputPath}`); },
  () => undefined,
);
await mkdir(runRoot, { recursive: true });

async function run(name: string, command: string, args: string[]) {
  const logPath = path.join(runRoot, `${name}.log`);
  const child = spawn(command, args, { cwd: workspace, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  const chunks: Buffer[] = [];
  child.stdout.on("data", (c) => chunks.push(c));
  child.stderr.on("data", (c) => chunks.push(c));
  const code: number = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (v) => resolve(v ?? 1));
  });
  const output = Buffer.concat(chunks);
  await writeFile(logPath, output);
  return { name, exitCode: code, logSha256: createHash("sha256").update(output).digest("hex") };
}

const identity = await createBuildIdentity(workspace);
const typecheck = await run("typecheck", "npm", ["run", "typecheck"]);
assert(typecheck.exitCode === 0, "typecheck 失败");

const targeted = await run("p9-targeted", "npx", [
  "vitest", "run",
  "tests/studio-reliability.test.ts",
  "tests/command-ledger-store.test.ts",
  "tests/studio-scale-fixture.test.ts",
  "tests/studio-production-dashboard.test.ts",
  "tests/studio-production-dashboard-ui.test.ts",
]);
assert(targeted.exitCode === 0, "P9 定向测试失败");

try {
  await access(scaleEvidencePath);
} catch {
  const scale = await run("p9-scale", "npx", ["tsx", "scripts/run-p9-scale-evidence.ts", scaleEvidencePath]);
  assert(scale.exitCode === 0, "P9 规模证据生成失败");
}

try {
  await access(mediaScalePath);
} catch {
  const media = await run("p9-media", "npx", ["tsx", "scripts/run-p9-media-scale-evidence.ts", mediaScalePath]);
  assert(media.exitCode === 0, "P9 媒体规模证据失败");
}

const scaleEvidence = JSON.parse(await readFile(scaleEvidencePath, "utf8")) as any;
assert(scaleEvidence.status === "pass", "规模证据非 pass");
assert(scaleEvidence.dashboard?.panelsExactMatch === true || scaleEvidence.gates?.exactPanelCount === true, "精确宫格未通过");
assert((scaleEvidence.observed?.units ?? 0) === 1288, "非 1288 单元");
assert((scaleEvidence.observed?.panels ?? 0) === expectedPanelCountForUnits(P9_SCALE_UNIT_COUNT), "宫格公式不一致");
assert((scaleEvidence.observed?.assets ?? 0) === 77, "非 77 资产");
assert((scaleEvidence.observed?.productionPath?.bindingSets ?? 0) >= 6, "生产路径 Binding 不足");

const mediaScale = JSON.parse(await readFile(mediaScalePath, "utf8")) as any;
assert(mediaScale.status === "pass", "媒体规模非 pass");
assert((mediaScale.counts?.mediaIndexed ?? 0) >= 10_000, "媒体索引不足 10k");
assert(mediaScale.mediaQuality?.placeholderSignatureOnly === false, "仍是签名占位");

const finalBody = {
  schemaVersion: 2,
  kind: "final-validation-p9r-reliability",
  status: "PARTIAL",
  note: "规模精确计数+真实媒体+生产路径+命令账本O(1)+驾驶舱多流 token 已过；全量故障矩阵与 Electron 10k 滚动 smoke 未宣称穷尽。",
  createdAt: new Date().toISOString(),
  buildIdentity: {
    buildId: identity.buildId,
    sourceDigest: identity.sourceDigest,
    sourceFiles: identity.roots.sourceFiles,
    capabilities: identity.capabilities,
  },
  scale: {
    units: scaleEvidence.observed.units,
    panels: scaleEvidence.observed.panels,
    assets: scaleEvidence.observed.assets,
    formulaPanels: expectedPanelCountForUnits(P9_SCALE_UNIT_COUNT),
    productionPath: scaleEvidence.observed.productionPath,
  },
  media: mediaScale.counts,
  evidence: {
    scale: scaleEvidencePath,
    media: mediaScalePath,
  },
  runs: { typecheck, targeted },
};
const content = `${JSON.stringify(finalBody, null, 2)}\n`;
await writeFile(outputPath, content, "utf8");
console.log(JSON.stringify({
  ok: true,
  status: "PARTIAL",
  outputPath,
  sha256: createHash("sha256").update(content).digest("hex"),
  units: finalBody.scale.units,
  panels: finalBody.scale.panels,
}, null, 2));
