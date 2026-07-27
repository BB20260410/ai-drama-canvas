/**
 * 项目注册表只读诊断。只读取 registry 与工程根存在性，不登记、不注销、不 prune。
 *
 * 用法：
 *   npx tsx scripts/diagnose-project-registry-safety.ts
 *   AI_CANVAS_REGISTRY_PATH=/abs/projects.json npx tsx scripts/diagnose-project-registry-safety.ts
 */
import { access } from "node:fs/promises";
import {
  diagnoseProjectRegistryEntries,
  getProjectRegistryPath,
  readJson,
} from "../src/core/sidecar.js";

interface RegistryEntry {
  id: string;
  name: string;
  primaryRoot: string;
  updatedAt: string;
}

async function main(): Promise<void> {
  const registryPath = getProjectRegistryPath();
  const entries = await readJson<RegistryEntry[]>(registryPath, []);
  const diagnostic = diagnoseProjectRegistryEntries(entries);
  const temporaryEntries = await Promise.all(diagnostic.temporaryEntries.map(async (entry) => ({
    ...entry,
    exists: await access(entry.primaryRoot).then(() => true, () => false),
  })));
  const unavailableEntries = (await Promise.all(entries.map(async (entry) => ({
    ...entry,
    exists: await access(entry.primaryRoot).then(() => true, () => false),
  })))).filter((entry) => !entry.exists);
  process.stdout.write(`${JSON.stringify({
    schemaVersion: 1,
    kind: "project-registry-readonly-diagnostic",
    registryPath,
    total: diagnostic.total,
    temporaryEntries,
    unavailableEntries,
    cleanupPlan: diagnostic.cleanupPlan,
    mutationPerformed: false,
  }, null, 2)}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
