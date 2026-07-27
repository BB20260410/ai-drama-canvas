import { access, mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { upsertAssetRelation, upsertVoiceIdentity } from "../src/core/asset-registry.js";
import { commitProjectImport, prepareProjectImport } from "../src/core/importer.js";
import { upsertProjectContext } from "../src/core/memory.js";
import { getProductionWorkflow, upsertCreativeBible } from "../src/core/production.js";
import { scanAndPersist } from "../src/core/service.js";
import { resetOwnedFixtureRoot } from "./lib/owned-fixture-root.js";

const defaultSuffix = `${process.pid}-${randomUUID()}`;
const projectRoot = path.resolve(process.argv[2] || path.join(os.tmpdir(), `ai-canvas-revision-cas-ui-${defaultSuffix}`));
const registryPath = path.resolve(process.argv[3] || path.join(os.tmpdir(), `ai-canvas-revision-cas-ui-registry-${defaultSuffix}.json`));
process.env.AI_CANVAS_REGISTRY_PATH = registryPath;

await access(registryPath).then(
  () => { throw new Error(`Revision CAS registry 必须是全新文件，拒绝覆盖：${registryPath}`); },
  () => undefined,
);
await resetOwnedFixtureRoot(projectRoot, "prepare-revision-cas-ui-fixture");

for (const [unit, title] of [[1, "雨夜相认"], [2, "祭坛回望"]] as const) {
  const stem = `EP01_15s_${String(unit).padStart(3, "0")}`;
  const directory = path.join(projectRoot, `${stem}_${title}`);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "00_信息.md"), `# ${stem} ${title}\n\nRevision CAS 双客户端 UI 验收夹具。\n`, "utf8");
  await writeFile(path.join(directory, `${stem}.txt`), `${title}\n两客户端共享同一真实侧车。\n`, "utf8");
}

const preview = await prepareProjectImport({
  primaryRoot: projectRoot,
  projectMode: "filesystem",
  name: "Revision CAS 双客户端验收",
});
if (!preview.canImport) throw new Error(preview.issues.map((issue) => issue.message).join("；"));
await commitProjectImport({ previewId: preview.previewId, config: preview.config, projectMode: "filesystem" });
const index = await scanAndPersist(projectRoot);
const units = index.items.filter((item) => item.type === "unit").sort((a, b) => (a.unit ?? 0) - (b.unit ?? 0));
if (units.length < 2) throw new Error(`Revision CAS UI 夹具需要两个 unit，实际 ${units.length} 个。`);

const bible = await upsertCreativeBible(projectRoot, {
  kind: "director",
  name: "双客户端导演 Bible",
  summary: "初始导演约束",
  rules: ["winner 的修改必须保留"],
  forbidden: ["禁止 loser 静默覆盖"],
  tags: ["revision-cas", "hidden-preserve"],
});
const relation = await upsertAssetRelation(projectRoot, {
  kind: "reference_of",
  parentItemId: units[0]!.id,
  childItemId: units[1]!.id,
  operation: "初始参考关系",
  note: "用于双客户端 stale update 验收",
});
const voice = await upsertVoiceIdentity(projectRoot, {
  name: "双客户端旁白",
  provider: "local-fixture",
  providerVoiceId: "voice-initial",
  language: "zh-CN",
  description: "初始声音描述",
  tags: ["revision-cas", "hidden-preserve"],
});
const updateContext = await upsertProjectContext(projectRoot, {
  kind: "continuity",
  title: "双客户端更新竞争",
  content: "初始更新内容",
  tags: ["revision-cas", "update"],
  itemIds: [units[0]!.id],
});
const deleteContext = await upsertProjectContext(projectRoot, {
  kind: "decision",
  title: "双客户端删除竞争",
  content: "初始删除内容",
  tags: ["revision-cas", "delete"],
  itemIds: [units[1]!.id],
});
const workflow = await getProductionWorkflow(projectRoot);

process.stdout.write(`${JSON.stringify({
  projectRoot,
  registryPath,
  itemIds: units.slice(0, 2).map((item) => item.id),
  workflowRevision: workflow.revision,
  bible: { id: bible.id, revision: bible.revision },
  relation: { id: relation.id, revision: relation.revision },
  voice: { id: voice.id, revision: voice.revision },
  updateContext: { id: updateContext.id, revision: updateContext.revision },
  deleteContext: { id: deleteContext.id, revision: deleteContext.revision },
})}\n`);
