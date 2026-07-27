/**
 * P24 golden 显式审核更新通道（规范 §2.7）：
 * 必须显式 `P24_GOLDEN_UPDATE=1 npx tsx scripts/update-p24-golden.ts`，重算全部 30 case 并写回
 * tests/fixtures/p24-trace-golden.json（带 schemaVersion/updatedAt/sourceDigest 标记）。
 * 默认拒绝写入；测试运行永不调用本脚本——baseline 只能显式审核更新，不静默覆盖失败。
 */
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { computeSourceDigest } from "../src/core/build-identity.js";
import {
  executeStudioP24GoldenCase,
  STUDIO_P24_GOLDEN_CASES,
  type StudioP24GoldenExpectation,
  type StudioP24GoldenFile,
} from "../tests/helpers/studio-p24-golden-cases.js";

if (process.env.P24_GOLDEN_UPDATE !== "1") {
  console.error("拒绝写入：baseline 只能显式审核更新。请确认全部变更已审阅后执行 P24_GOLDEN_UPDATE=1 npx tsx scripts/update-p24-golden.ts");
  process.exit(1);
}

const workspace = path.resolve(process.cwd());
const goldenPath = path.join(workspace, "tests/fixtures/p24-trace-golden.json");

const cases: Record<string, StudioP24GoldenExpectation> = {};
for (const goldenCase of STUDIO_P24_GOLDEN_CASES) {
  process.stdout.write(`重算 ${goldenCase.id} …\n`);
  const actual = await executeStudioP24GoldenCase(goldenCase);
  if (actual.classification !== goldenCase.classification) {
    throw new Error(`case ${goldenCase.id} 分类漂移：矩阵声明 ${goldenCase.classification}，实际 ${actual.classification}。请先排查再更新 baseline。`);
  }
  if (actual.impactClassification !== goldenCase.classification) {
    throw new Error(`case ${goldenCase.id} impact 行分类漂移：矩阵声明 ${goldenCase.classification}，实际 ${String(actual.impactClassification)}。请先排查再更新 baseline。`);
  }
  if (!actual.impactPackHit) {
    throw new Error(`case ${goldenCase.id} impact 未命中 pack：追溯链断裂，请先排查再更新 baseline。`);
  }
  if (!actual.atTheTime.promptPreserved || !actual.atTheTime.scriptPreserved
    || !actual.atTheTime.bindingSetPreserved || !actual.atTheTime.continuityPreserved) {
    throw new Error(`case ${goldenCase.id} 当时值还原被破坏（trace 读到了 head 而非冻结包身份），请先排查再更新 baseline。`);
  }
  cases[goldenCase.id] = {
    classification: actual.classification,
    expectedContains: actual.expectedReasons,
    unexpectedContains: actual.unexpectedReasons,
    atTheTime: actual.atTheTime,
    impactPackHit: true,
    impactClassification: goldenCase.classification,
  };
}

const digest = await computeSourceDigest(workspace);
const golden: StudioP24GoldenFile = {
  schemaVersion: 1,
  updatedAt: new Date().toISOString(),
  sourceDigest: digest.sourceDigest,
  note: "P24 固定样本 baseline（3 格型×5 差异×2 分类=30 case）。只能经本脚本显式审核更新；runner 只比对不写。差异类映射说明（附录 D F-R2-03）：asset/binding-set 共享 rebind 触发器、continuity 以 script-changed 呈现、source-spans 以 unit-changed 呈现——BindingSet 词表仅有 4 种可区分观测，覆盖为真但非五路独立词。",
  cases,
};
await writeFile(goldenPath, `${JSON.stringify(golden, null, 2)}\n`, "utf8");
process.stdout.write(`已写回 ${goldenPath}（${STUDIO_P24_GOLDEN_CASES.length} case，sourceDigest=${digest.sourceDigest.slice(0, 12)}…）。\n`);
