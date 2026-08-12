import { constants, createReadStream } from "node:fs";
import {
  access,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

export interface VerifiedElectronCacheSeed {
  archiveName: string;
  expectedSha256: string;
  seeded: boolean;
  sourcePath?: string;
  targetPath?: string;
  sourceSha256?: string;
  targetSha256?: string;
}

async function exists(candidate: string): Promise<boolean> {
  return access(candidate).then(() => true, () => false);
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

async function findArchiveCandidates(root: string, archiveName: string): Promise<string[]> {
  if (!(await exists(root))) return [];
  const matches: string[] = [];
  async function visit(directory: string, depth: number): Promise<void> {
    if (depth > 3) return;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) await visit(entryPath, depth + 1);
      else if (entry.isFile() && entry.name === archiveName) matches.push(entryPath);
    }
  }
  await visit(root, 0);
  return matches.sort((left, right) => {
    const leftDepth = path.relative(root, left).split(path.sep).length;
    const rightDepth = path.relative(root, right).split(path.sep).length;
    return rightDepth - leftDepth || left.localeCompare(right);
  });
}

export async function seedVerifiedElectronCache(input: {
  electronPackageRoot: string;
  archiveName: string;
  sourceCacheRoots: string[];
  targetCacheRoot: string;
}): Promise<VerifiedElectronCacheSeed> {
  const checksums = JSON.parse(await readFile(
    path.join(input.electronPackageRoot, "checksums.json"),
    "utf8",
  )) as Record<string, string>;
  const expectedSha256 = checksums[input.archiveName] ?? "";
  if (!/^[a-f0-9]{64}$/u.test(expectedSha256)) {
    throw new Error(`Electron checksums.json 缺少有效归档摘要：${input.archiveName}`);
  }
  await mkdir(input.targetCacheRoot, { recursive: true });
  for (const sourceCacheRoot of input.sourceCacheRoots) {
    for (const sourcePath of await findArchiveCandidates(sourceCacheRoot, input.archiveName)) {
      const sourceStat = await lstat(sourcePath);
      if (!sourceStat.isFile()) continue;
      const sourceSha256 = await sha256File(sourcePath);
      if (sourceSha256 !== expectedSha256) continue;
      const relativePath = path.relative(sourceCacheRoot, sourcePath);
      if (!relativePath || relativePath === ".." || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) {
        throw new Error(`Electron cache 候选逃逸来源根目录：${sourcePath}`);
      }
      const targetPath = path.join(input.targetCacheRoot, relativePath);
      await mkdir(path.dirname(targetPath), { recursive: true });
      if (!(await exists(targetPath))) await copyFile(sourcePath, targetPath, constants.COPYFILE_EXCL);
      const targetSha256 = await sha256File(targetPath);
      if (targetSha256 !== expectedSha256) {
        throw new Error(`Electron 隔离缓存复制后摘要不一致：${targetPath}`);
      }
      return {
        archiveName: input.archiveName,
        expectedSha256,
        seeded: true,
        sourcePath,
        targetPath,
        sourceSha256,
        targetSha256,
      };
    }
  }
  return { archiveName: input.archiveName, expectedSha256, seeded: false };
}
