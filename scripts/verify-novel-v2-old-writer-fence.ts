import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { computeSourceDigest } from "../src/core/build-identity.js";
import { withProjectLock } from "../src/core/locks.js";
import { createManagedProject, inspectManagedProjectReadOnly } from "../src/core/managed-project.js";
import { createManagedProjectBackup } from "../src/core/project-backup.js";
import {
  getActiveProjectStateReadOnly,
  getProjectRegistryV2Path,
  listRegisteredProjects,
  registerProject,
  setActiveHybridWorkspacePreference,
  setActiveProjectRegistration,
} from "../src/core/sidecar.js";

const execFileAsync = promisify(execFile);
const workspace = path.resolve(process.argv[2] ?? process.cwd());
const evidencePath = path.resolve(process.argv[3] ?? path.join(
  workspace,
  "docs",
  "evidence",
  "novel-mode-v1",
  "p1",
  "final",
  "old-writer-fence.json",
));
const allowedEvidenceRoot = path.join(workspace, "docs", "evidence", "novel-mode-v1", "p1");
const evidenceRelative = path.relative(allowedEvidenceRoot, evidencePath);
if (evidenceRelative === ".." || evidenceRelative.startsWith(`..${path.sep}`) || path.isAbsolute(evidenceRelative)) {
  throw new Error(`P1 old-writer 证据必须写入 ${allowedEvidenceRoot}`);
}

const OLD_WRITER_COMMIT = "1e8e9d9c8cb055987d53b8fa0b503fb80538b3f5";

interface TreeIdentity {
  entries: number;
  files: number;
  bytes: number;
  aggregateSha256: string;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

async function treeIdentity(root: string): Promise<TreeIdentity> {
  const records: string[] = [];
  let files = 0;
  let bytes = 0;
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      const relativePath = path.relative(root, absolutePath).split(path.sep).join("/");
      if (entry.isDirectory()) {
        records.push(`d\t${relativePath}`);
        await visit(absolutePath);
      } else if (entry.isFile()) {
        const content = await readFile(absolutePath);
        files += 1;
        bytes += content.byteLength;
        records.push(`f\t${relativePath}\t${content.byteLength}\t${sha256(content)}`);
      } else if (entry.isSymbolicLink()) {
        records.push(`l\t${relativePath}`);
      } else {
        records.push(`o\t${relativePath}`);
      }
    }
  };
  await visit(root);
  return {
    entries: records.length,
    files,
    bytes,
    aggregateSha256: sha256(`${records.join("\n")}\n`),
  };
}

function sameTree(left: TreeIdentity, right: TreeIdentity): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sanitize(value: string, replacements: Array<[string, string]>): string {
  return replacements.reduce(
    (current, [sensitive, replacement]) => current.split(sensitive).join(replacement),
    value,
  );
}

await readFile(evidencePath).then(
  () => { throw new Error(`证据已存在，拒绝覆盖：${evidencePath}`); },
  (error: unknown) => {
    if (!(error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT")) throw error;
  },
);

const temporaryRoot = await mkdtemp(path.join(await realpath(os.tmpdir()), "novel-v2-old-writer-fence-"));
const previousRegistryPath = process.env.AI_CANVAS_REGISTRY_PATH;
let wroteEvidence = false;

try {
  const registryRoot = path.join(temporaryRoot, "registry");
  const registryPath = path.join(registryRoot, "projects.json");
  process.env.AI_CANVAS_REGISTRY_PATH = registryPath;
  const projectsParent = path.join(temporaryRoot, "projects");
  await mkdir(projectsParent, { recursive: true });

  const drama = await createManagedProject({ parentRoot: projectsParent, name: "Old Writer Visible Drama" });
  const novel = await createManagedProject({
    parentRoot: projectsParent,
    name: "Old Writer Fenced Novel",
    workspaceMode: "novel",
  });
  const hybrid = await createManagedProject({
    parentRoot: projectsParent,
    name: "Old Writer Preference Hybrid",
    workspaceMode: "hybrid",
  });
  await registerProject(drama.project);
  await registerProject(novel.project);
  await registerProject(hybrid.project);
  await setActiveProjectRegistration(novel.paths.root);

  const legacyRegistryBytes = await readFile(registryPath);
  const v2RegistryBytes = await readFile(getProjectRegistryV2Path());
  const activePointerPath = path.join(registryRoot, "active-project.json");
  const activePointerBytes = await readFile(activePointerPath);
  const activeState = await getActiveProjectStateReadOnly();
  if (activeState?.schemaVersion !== 3 || activeState.primaryRoot !== novel.paths.root) {
    throw new Error("current writer 未把活动 v2 工程写成 schema v3 活动指针。");
  }
  const currentProjects = await listRegisteredProjects();
  if (!currentProjects.some((project) => project.primaryRoot === novel.paths.root)) {
    throw new Error("current writer 无法读取独立 v2 注册表。");
  }

  const projectBefore = await treeIdentity(novel.paths.root);
  const registryBefore = await treeIdentity(registryRoot);
  const manifestBytesBefore = await readFile(novel.paths.manifest);
  const fencePath = path.join(novel.paths.sidecar, "locks");
  const fenceBytesBefore = await readFile(fencePath);
  const legacyCachePath = path.join(novel.paths.sidecar, "cache.sqlite");
  const legacyCacheBytesBefore = await readFile(legacyCachePath);
  const v2CacheBytesBefore = await readFile(novel.paths.cache);

  const oldWriterRoot = path.join(temporaryRoot, "old-writer");
  const archivePath = path.join(temporaryRoot, "old-writer.tar");
  await mkdir(oldWriterRoot);
  const commit = (await execFileAsync("git", ["rev-parse", `${OLD_WRITER_COMMIT}^{commit}`], { cwd: workspace })).stdout.trim();
  const tree = (await execFileAsync("git", ["rev-parse", `${OLD_WRITER_COMMIT}^{tree}`], { cwd: workspace })).stdout.trim();
  if (commit !== OLD_WRITER_COMMIT) throw new Error(`旧 writer commit 身份不匹配：${commit}`);
  await execFileAsync("git", ["archive", "--format=tar", `--output=${archivePath}`, commit], { cwd: workspace });
  await execFileAsync("tar", ["-xf", archivePath, "-C", oldWriterRoot]);
  await symlink(path.join(workspace, "node_modules"), path.join(oldWriterRoot, "node_modules"), "dir");

  const oldWriterScript = [
    "void (async () => {",
    "  const { readFile } = await import('node:fs/promises');",
    "  const { createBuildIdentity } = await import('./src/core/build-identity.ts');",
    "  const { listRegisteredProjects } = await import('./src/core/sidecar.ts');",
    "  const { activateProject, loadCanvasPositions, saveCanvasPositions, saveProjectConfig } = await import('./src/core/service.ts');",
    "  const { prepareProjectImport, commitProjectImport } = await import('./src/core/importer.ts');",
    "  const { upsertCanvasEntity } = await import('./src/core/canvas-state.ts');",
    "  const identity = await createBuildIdentity(process.cwd(), { queriedAt: '2026-08-01T00:00:00.000Z' });",
    "  const visibleProjects = await listRegisteredProjects();",
    "  const targetConfig = JSON.parse(await readFile(`${process.env.TARGET_PROJECT_ROOT}/.aicanvas/project.json`, 'utf8'));",
    "  const result = {",
    "    identity: { buildId: identity.buildId, sourceDigest: identity.sourceDigest, sourceFiles: identity.roots.sourceFiles, sourceBytes: identity.roots.sourceBytes, fingerprint: identity.fingerprint },",
    "    targetVisible: visibleProjects.some((project) => project.primaryRoot === process.env.TARGET_PROJECT_ROOT),",
    "    visibleProjectIds: visibleProjects.map((project) => project.id).sort(),",
    "    activate: null,",
    "    storyFirstPrepare: null,",
    "    storyFirstCommit: null,",
    "    settingsSave: null,",
    "    layoutLoad: null,",
    "    layoutSave: null,",
    "    explicitRootUpsert: null,",
    "  };",
    "  try {",
    "    await activateProject(process.env.TARGET_PROJECT_ROOT);",
    "    result.activate = { accepted: true, error: null };",
    "  } catch (error) {",
    "    result.activate = { accepted: false, error: error instanceof Error ? error.message : String(error) };",
    "  }",
    "  try {",
    "    await prepareProjectImport({ primaryRoot: process.env.TARGET_PROJECT_ROOT, projectMode: 'story_first' });",
    "    result.storyFirstPrepare = { accepted: true, error: null };",
    "  } catch (error) {",
    "    result.storyFirstPrepare = { accepted: false, error: error instanceof Error ? error.message : String(error) };",
    "  }",
    "  try {",
    "    await commitProjectImport({ previewId: 'forged-old-writer-preview', config: targetConfig, projectMode: 'story_first' });",
    "    result.storyFirstCommit = { accepted: true, error: null };",
    "  } catch (error) {",
    "    result.storyFirstCommit = { accepted: false, error: error instanceof Error ? error.message : String(error) };",
    "  }",
    "  try {",
    "    await saveProjectConfig(targetConfig);",
    "    result.settingsSave = { accepted: true, error: null };",
    "  } catch (error) {",
    "    result.settingsSave = { accepted: false, error: error instanceof Error ? error.message : String(error) };",
    "  }",
    "  try {",
    "    await loadCanvasPositions(process.env.TARGET_PROJECT_ROOT, 'old-writer-layout');",
    "    result.layoutLoad = { accepted: true, error: null };",
    "  } catch (error) {",
    "    result.layoutLoad = { accepted: false, error: error instanceof Error ? error.message : String(error) };",
    "  }",
    "  try {",
    "    await saveCanvasPositions(process.env.TARGET_PROJECT_ROOT, 'old-writer-layout', { node: { x: 1, y: 2 } });",
    "    result.layoutSave = { accepted: true, error: null };",
    "  } catch (error) {",
    "    result.layoutSave = { accepted: false, error: error instanceof Error ? error.message : String(error) };",
    "  }",
    "  try {",
    "    await upsertCanvasEntity(process.env.TARGET_PROJECT_ROOT, { kind: 'note', title: 'old-writer-probe' });",
    "    result.explicitRootUpsert = { accepted: true, error: null };",
    "  } catch (error) {",
    "    result.explicitRootUpsert = { accepted: false, error: error instanceof Error ? error.message : String(error) };",
    "  }",
    "  process.stdout.write(JSON.stringify(result));",
    "})();",
  ].join("\n");
  const oldWriterScriptSha256 = sha256(oldWriterScript);
  const oldRun = await execFileAsync(
    path.join(workspace, "node_modules", ".bin", "tsx"),
    ["-e", oldWriterScript],
    {
      cwd: oldWriterRoot,
      env: {
        ...process.env,
        AI_CANVAS_REGISTRY_PATH: registryPath,
        TARGET_PROJECT_ROOT: novel.paths.root,
      },
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  const parsed = JSON.parse(oldRun.stdout) as {
    identity: { buildId: string; sourceDigest: string; sourceFiles: number; sourceBytes: number; fingerprint: string };
    targetVisible: boolean;
    visibleProjectIds: string[];
    activate: { accepted: boolean; error: string | null };
    storyFirstPrepare: { accepted: boolean; error: string | null };
    storyFirstCommit: { accepted: boolean; error: string | null };
    settingsSave: { accepted: boolean; error: string | null };
    layoutLoad: { accepted: boolean; error: string | null };
    layoutSave: { accepted: boolean; error: string | null };
    explicitRootUpsert: { accepted: boolean; error: string | null };
  };

  const projectAfterOldWriter = await treeIdentity(novel.paths.root);
  const registryAfterOldWriter = await treeIdentity(registryRoot);
  const manifestBytesAfter = await readFile(novel.paths.manifest);
  const fenceBytesAfter = await readFile(fencePath);
  const oldWriterRejected = !parsed.targetVisible
    && parsed.activate.accepted === false
    && parsed.storyFirstPrepare.accepted === false
    && parsed.storyFirstCommit.accepted === false
    && parsed.settingsSave.accepted === false
    && parsed.layoutLoad.accepted === false
    && parsed.layoutSave.accepted === false
    && parsed.explicitRootUpsert.accepted === false;
  const projectUnchanged = sameTree(projectBefore, projectAfterOldWriter)
    && manifestBytesBefore.equals(manifestBytesAfter)
    && fenceBytesBefore.equals(fenceBytesAfter)
    && legacyCacheBytesBefore.equals(await readFile(legacyCachePath))
    && v2CacheBytesBefore.equals(await readFile(novel.paths.cache));
  const legacyRegistryBytesUnchangedAfterOldWriter = legacyRegistryBytes.equals(await readFile(registryPath));
  const v2RegistryBytesUnchangedAfterOldWriter = v2RegistryBytes.equals(await readFile(getProjectRegistryV2Path()));
  const activePointerBytesUnchangedAfterOldWriter = activePointerBytes.equals(await readFile(activePointerPath));
  const registryUnchanged = sameTree(registryBefore, registryAfterOldWriter)
    && legacyRegistryBytesUnchangedAfterOldWriter
    && v2RegistryBytesUnchangedAfterOldWriter
    && activePointerBytesUnchangedAfterOldWriter;
  if (!oldWriterRejected || !projectUnchanged || !registryUnchanged) {
    throw new Error("旧 writer fence canary 失败：旧 writer 可达或前后树身份发生变化。");
  }

  const backup = await createManagedProjectBackup(novel.paths.root, path.join(temporaryRoot, "backups"));
  const backupProjectRoot = path.join(backup.backupRoot, "project");
  const backupProjectBeforeOldWriter = await treeIdentity(backupProjectRoot);
  const oldBackupCacheScript = [
    "void (async () => {",
    "  const { loadCanvasPositions, saveCanvasPositions } = await import('./src/core/service.ts');",
    "  const result = { load: null, save: null };",
    "  try { await loadCanvasPositions(process.env.TARGET_BACKUP_PROJECT_ROOT, 'old-backup-layout'); result.load = { accepted: true, error: null }; }",
    "  catch (error) { result.load = { accepted: false, error: error instanceof Error ? error.message : String(error) }; }",
    "  try { await saveCanvasPositions(process.env.TARGET_BACKUP_PROJECT_ROOT, 'old-backup-layout', { node: { x: 7, y: 9 } }); result.save = { accepted: true, error: null }; }",
    "  catch (error) { result.save = { accepted: false, error: error instanceof Error ? error.message : String(error) }; }",
    "  process.stdout.write(JSON.stringify(result));",
    "})();",
  ].join("\n");
  const oldBackupRun = await execFileAsync(
    path.join(workspace, "node_modules", ".bin", "tsx"),
    ["-e", oldBackupCacheScript],
    {
      cwd: oldWriterRoot,
      env: { ...process.env, TARGET_BACKUP_PROJECT_ROOT: backupProjectRoot },
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  const oldBackupParsed = JSON.parse(oldBackupRun.stdout) as {
    load: { accepted: boolean; error: string | null };
    save: { accepted: boolean; error: string | null };
  };
  const backupProjectAfterOldWriter = await treeIdentity(backupProjectRoot);
  const backupCacheFenceHeld = !oldBackupParsed.load.accepted
    && !oldBackupParsed.save.accepted
    && sameTree(backupProjectBeforeOldWriter, backupProjectAfterOldWriter);
  if (!backupCacheFenceHeld) throw new Error("备份副本未保留旧 ProjectCache 物理 fence。");

  // old writer 尝试结束并完成零写对账后，再证明 current writer 仍能通过 v2 锁目录写临界区。
  let currentWriterEntered = false;
  await withProjectLock(novel.paths.root, "current-writer-canary", async () => {
    currentWriterEntered = true;
  });
  if (!currentWriterEntered) throw new Error("current writer 未进入 v2 写锁临界区。");
  await inspectManagedProjectReadOnly(novel.paths.root);
  if (!fenceBytesBefore.equals(await readFile(fencePath))) throw new Error("current writer 取锁改变了 writer fence。");

  await setActiveProjectRegistration(hybrid.paths.root);
  await setActiveHybridWorkspacePreference(hybrid.project.id, "novel");
  await setActiveProjectRegistration(drama.paths.root);
  const rawDramaActiveBeforeOld = JSON.parse(await readFile(activePointerPath, "utf8")) as Record<string, unknown>;
  if (rawDramaActiveBeforeOld.schemaVersion !== 2
    || rawDramaActiveBeforeOld.primaryRoot !== drama.paths.root
    || "workspacePreferences" in rawDramaActiveBeforeOld) {
    throw new Error("切回 drama 后 active pointer 未保持旧 writer 可读 schema2。");
  }
  const preferencesPath = path.join(registryRoot, "workspace-preferences-v2.json");
  const preferencesBytesBeforeOld = await readFile(preferencesPath);
  const oldDramaScript = [
    "void (async () => {",
    "  const { activateProject, getActiveProjectReadOnly } = await import('./src/core/service.ts');",
    "  const before = await getActiveProjectReadOnly();",
    "  const activated = await activateProject(process.env.TARGET_DRAMA_ROOT);",
    "  process.stdout.write(JSON.stringify({ before, activated }));",
    "})();",
  ].join("\n");
  const oldDramaRun = await execFileAsync(
    path.join(workspace, "node_modules", ".bin", "tsx"),
    ["-e", oldDramaScript],
    {
      cwd: oldWriterRoot,
      env: {
        ...process.env,
        AI_CANVAS_REGISTRY_PATH: registryPath,
        TARGET_DRAMA_ROOT: drama.paths.root,
      },
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  const oldDramaParsed = JSON.parse(oldDramaRun.stdout) as {
    before: { id: string; primaryRoot: string; available: boolean } | null;
    activated: { id: string; primaryRoot: string; available: boolean };
  };
  const rawDramaActiveAfterOld = JSON.parse(await readFile(activePointerPath, "utf8")) as Record<string, unknown>;
  const oldDramaCompatible = oldDramaParsed.before?.id === drama.project.id
    && oldDramaParsed.before.primaryRoot === drama.paths.root
    && oldDramaParsed.before.available === true
    && oldDramaParsed.activated.id === drama.project.id
    && oldDramaParsed.activated.primaryRoot === drama.paths.root
    && oldDramaParsed.activated.available === true
    && rawDramaActiveAfterOld.schemaVersion === 2
    && rawDramaActiveAfterOld.primaryRoot === drama.paths.root
    && !("workspacePreferences" in rawDramaActiveAfterOld)
    && preferencesBytesBeforeOld.equals(await readFile(preferencesPath));
  if (!oldDramaCompatible) throw new Error("hybrid 偏好导致旧 writer 无法继续操作 drama v1。");

  const currentSource = await computeSourceDigest(workspace);
  const replacements: Array<[string, string]> = [
    [novel.paths.root, "<v2-project-root>"],
    [hybrid.paths.root, "<v2-hybrid-root>"],
    [drama.paths.root, "<v1-project-root>"],
    [backupProjectRoot, "<backup-project-root>"],
    [temporaryRoot, "<temporary-root>"],
    [workspace, "<workspace>"],
  ];
  const evidence = {
    schemaVersion: 1,
    kind: "novel-v2-old-writer-fence-evidence",
    verdict: "PASS",
    capturedAt: new Date().toISOString(),
    currentWriter: {
      sourceDigest: currentSource.sourceDigest,
      sourceFiles: currentSource.sourceFiles,
      sourceBytes: currentSource.sourceBytes,
      schemaVersion: 2,
      activePointerSchemaVersion: activeState.schemaVersion,
      currentWriterLockEntered: currentWriterEntered,
    },
    oldWriter: {
      commit,
      tree,
      ...parsed.identity,
      execution: "immutable git archive executed through repository-pinned tsx",
      scriptSha256: oldWriterScriptSha256,
      stdoutSha256: sha256(oldRun.stdout),
      stderrSha256: sha256(oldRun.stderr),
      exitCode: 0,
    },
    reachability: {
      targetVisibleInLegacyRegistry: parsed.targetVisible,
      visibleProjectIds: parsed.visibleProjectIds,
      activate: {
        accepted: parsed.activate.accepted,
        error: sanitize(parsed.activate.error ?? "", replacements),
      },
      storyFirstPrepare: {
        accepted: parsed.storyFirstPrepare.accepted,
        error: sanitize(parsed.storyFirstPrepare.error ?? "", replacements),
      },
      storyFirstCommit: {
        accepted: parsed.storyFirstCommit.accepted,
        error: sanitize(parsed.storyFirstCommit.error ?? "", replacements),
      },
      settingsSave: {
        accepted: parsed.settingsSave.accepted,
        error: sanitize(parsed.settingsSave.error ?? "", replacements),
      },
      layoutLoad: {
        accepted: parsed.layoutLoad.accepted,
        error: sanitize(parsed.layoutLoad.error ?? "", replacements),
      },
      layoutSave: {
        accepted: parsed.layoutSave.accepted,
        error: sanitize(parsed.layoutSave.error ?? "", replacements),
      },
      explicitRootUpsert: {
        accepted: parsed.explicitRootUpsert.accepted,
        error: sanitize(parsed.explicitRootUpsert.error ?? "", replacements),
      },
    },
    backupCopyFence: {
      held: backupCacheFenceHeld,
      oldWriterScriptSha256: sha256(oldBackupCacheScript),
      oldWriterStdoutSha256: sha256(oldBackupRun.stdout),
      sqliteSnapshotTreatsLegacyFenceAsOrdinary: !backup.manifest.snapshot?.sqliteDatabases.includes(".aicanvas/cache.sqlite"),
      layoutLoad: {
        accepted: oldBackupParsed.load.accepted,
        error: sanitize(oldBackupParsed.load.error ?? "", replacements),
      },
      layoutSave: {
        accepted: oldBackupParsed.save.accepted,
        error: sanitize(oldBackupParsed.save.error ?? "", replacements),
      },
      before: backupProjectBeforeOldWriter,
      after: backupProjectAfterOldWriter,
    },
    dramaCompatibility: {
      compatible: oldDramaCompatible,
      oldWriterScriptSha256: sha256(oldDramaScript),
      oldWriterStdoutSha256: sha256(oldDramaRun.stdout),
      rawActiveBeforeOld: {
        schemaVersion: rawDramaActiveBeforeOld.schemaVersion,
        primaryRoot: "<v1-project-root>",
        embedsWorkspacePreferences: "workspacePreferences" in rawDramaActiveBeforeOld,
      },
      oldWriter: {
        before: oldDramaParsed.before ? {
          id: oldDramaParsed.before.id,
          primaryRoot: "<v1-project-root>",
          available: oldDramaParsed.before.available,
        } : null,
        activated: {
          id: oldDramaParsed.activated.id,
          primaryRoot: "<v1-project-root>",
          available: oldDramaParsed.activated.available,
        },
      },
      rawActiveAfterOld: {
        schemaVersion: rawDramaActiveAfterOld.schemaVersion,
        primaryRoot: "<v1-project-root>",
        embedsWorkspacePreferences: "workspacePreferences" in rawDramaActiveAfterOld,
      },
      v2PreferencesBytesUnchanged: preferencesBytesBeforeOld.equals(await readFile(preferencesPath)),
    },
    invariants: {
      projectTreeUnchangedAfterOldWriter: projectUnchanged,
      registryTreeUnchangedAfterOldWriter: registryUnchanged,
      manifestBytesUnchanged: manifestBytesBefore.equals(manifestBytesAfter),
      writerFenceBytesUnchanged: fenceBytesBefore.equals(fenceBytesAfter),
      legacyCacheFenceBytesUnchanged: legacyCacheBytesBefore.equals(await readFile(legacyCachePath)),
      v2CacheBytesUnchanged: v2CacheBytesBefore.equals(await readFile(novel.paths.cache)),
      legacyRegistryBytesUnchangedAfterV2OldWriter: legacyRegistryBytesUnchangedAfterOldWriter,
      v2RegistryBytesUnchangedAfterV2OldWriter: v2RegistryBytesUnchangedAfterOldWriter,
      activePointerBytesUnchangedAfterV2OldWriter: activePointerBytesUnchangedAfterOldWriter,
    },
    identities: {
      projectBefore,
      projectAfterOldWriter,
      registryBefore,
      registryAfterOldWriter,
      manifestSha256: sha256(manifestBytesBefore),
      writerFenceSha256: sha256(fenceBytesBefore),
      legacyCacheFenceSha256: sha256(legacyCacheBytesBefore),
      v2CacheSha256: sha256(v2CacheBytesBefore),
      legacyRegistrySha256: sha256(legacyRegistryBytes),
      v2RegistrySha256: sha256(v2RegistryBytes),
      activePointerSha256: sha256(activePointerBytes),
      projectRootSha256: sha256(novel.paths.root),
      registryRootSha256: sha256(registryRoot),
    },
  };

  await mkdir(path.dirname(evidencePath), { recursive: true });
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  wroteEvidence = true;
  process.stdout.write(`${JSON.stringify({ verdict: "PASS", evidencePath }, null, 2)}\n`);
} finally {
  if (previousRegistryPath === undefined) delete process.env.AI_CANVAS_REGISTRY_PATH;
  else process.env.AI_CANVAS_REGISTRY_PATH = previousRegistryPath;
  await rm(temporaryRoot, { recursive: true, force: true });
  if (!wroteEvidence) await rm(evidencePath, { force: true }).catch(() => undefined);
}
