/**
 * 在隔离 stage 中构建不可变 MCP 候选树。
 *
 * 该脚本绝不执行工作区的 `npm run build:mcp`，因为那个命令会先删除 live
 * `dist-mcp`。它逐项复制 computeSourceDigest 的同一输入集合，在 stage 内执行
 * build:mcp → build:identity，再把完整 dist-mcp 发布到只增不改的版本目录。
 */
import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  computeSourceDigest,
  listSourceDigestFiles,
} from "../src/core/build-identity.js";
import {
  createImmutableMcpRuntimeCandidateReceipt,
  inspectImmutableMcpRuntimeTree,
  sealImmutableMcpRuntimeCandidate,
  serializeImmutableMcpRuntimeCandidateReceipt,
  verifyImmutableMcpRuntimeCandidate,
  type ImmutableMcpRuntimeCandidateReceipt,
  type ImmutableMcpRuntimeTreeIdentity,
} from "../src/core/immutable-mcp-runtime-candidate.js";

const DEFAULT_OUTPUT_RELATIVE_PATH = ".aicanvas-runtime/mcp-candidates";
const COMMAND_TIMEOUT_MS = 10 * 60_000;

export interface ImmutableMcpCandidateBuildCommandEvidence {
  name: "build:mcp" | "build:identity";
  executable: "/usr/bin/env";
  args: string[];
  cwd: string;
  exitCode: 0;
  stdoutTail: string;
  stderrTail: string;
}

export interface BuildImmutableMcpRuntimeCandidateInput {
  workspace?: string;
  outputRoot?: string;
  /**
   * 只供测试把候选落到系统临时目录；正式 CLI 只允许工作区隐藏候选根。
   */
  allowExternalOutputForTests?: boolean;
}

export interface BuildImmutableMcpRuntimeCandidateResult {
  schemaVersion: 1;
  kind: "immutable-mcp-runtime-candidate-build-result";
  candidateRoot: string;
  reused: boolean;
  receipt: ImmutableMcpRuntimeCandidateReceipt;
  commands: ImmutableMcpCandidateBuildCommandEvidence[];
  source: {
    before: string;
    stageBefore: string;
    stageAfter: string;
    after: string;
    unchanged: true;
  };
  liveDistMcp: {
    beforeFingerprint: string | null;
    afterFingerprint: string | null;
    unchanged: true;
  };
}

function tail(value: string, maxLines = 20, maxCharacters = 8_000): string {
  const selected = value.trim().split(/\r?\n/u).slice(-maxLines).join("\n");
  return selected.length > maxCharacters ? selected.slice(-maxCharacters) : selected;
}

function isInside(parentValue: string, candidateValue: string): boolean {
  const parent = path.resolve(parentValue);
  const candidate = path.resolve(candidateValue);
  const relative = path.relative(parent, candidate);
  return Boolean(relative)
    && relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

function sameSourceIdentity(
  left: Awaited<ReturnType<typeof computeSourceDigest>>,
  right: Awaited<ReturnType<typeof computeSourceDigest>>,
): boolean {
  return left.sourceDigest === right.sourceDigest
    && left.sourceFiles === right.sourceFiles
    && left.sourceBytes === right.sourceBytes;
}

function sameRuntimeTree(
  left: ImmutableMcpRuntimeTreeIdentity | null,
  right: ImmutableMcpRuntimeTreeIdentity | null,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function runtimeTreeOrNull(distMcpRoot: string): Promise<ImmutableMcpRuntimeTreeIdentity | null> {
  try {
    return await inspectImmutableMcpRuntimeTree(distMcpRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function runBuildCommand(
  name: ImmutableMcpCandidateBuildCommandEvidence["name"],
  stageRoot: string,
  environment: NodeJS.ProcessEnv,
): Promise<ImmutableMcpCandidateBuildCommandEvidence> {
  const args = ["npm", "run", name];
  return new Promise((resolve, reject) => {
    execFile(
      "/usr/bin/env",
      args,
      {
        cwd: stageRoot,
        env: environment,
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
        timeout: COMMAND_TIMEOUT_MS,
      },
      (error, stdout, stderr) => {
        const stdoutTail = tail(stdout);
        const stderrTail = tail(stderr);
        if (error) {
          reject(new Error(
            `隔离 MCP candidate ${name} 失败：${error.message}\n${stderrTail || stdoutTail}`,
          ));
          return;
        }
        resolve({
          name,
          executable: "/usr/bin/env",
          args,
          cwd: stageRoot,
          exitCode: 0,
          stdoutTail,
          stderrTail,
        });
      },
    );
  });
}

async function copyDirectoryCow(source: string, destinationParent: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    execFile(
      "/bin/cp",
      ["-cR", source, destinationParent],
      { encoding: "utf8", maxBuffer: 4 * 1024 * 1024, timeout: COMMAND_TIMEOUT_MS },
      (error, _stdout, stderr) => {
        if (error) reject(new Error(`APFS COW clone 失败：${error.message}\n${tail(stderr)}`));
        else resolve();
      },
    );
  });
}

async function copySourceDigestInputs(workspace: string, stageRoot: string): Promise<number> {
  const files = await listSourceDigestFiles(workspace);
  for (const sourcePath of files) {
    const relativePath = path.relative(workspace, sourcePath);
    if (!relativePath
      || relativePath === ".."
      || relativePath.startsWith(`..${path.sep}`)
      || path.isAbsolute(relativePath)) {
      throw new Error(`sourceDigest 输入逃逸工作区：${sourcePath}`);
    }
    const metadata = await lstat(sourcePath);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
      throw new Error(`sourceDigest 输入必须是单链接普通文件：${relativePath}`);
    }
    const targetPath = path.join(stageRoot, relativePath);
    await mkdir(path.dirname(targetPath), { recursive: true, mode: 0o700 });
    await copyFile(sourcePath, targetPath, fsConstants.COPYFILE_FICLONE);
    await chmod(targetPath, metadata.mode & 0o777);
  }
  return files.length;
}

async function makeWritableForCleanup(root: string): Promise<void> {
  let metadata;
  try {
    metadata = await lstat(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (metadata.isDirectory()) {
    await chmod(root, 0o700);
    for (const child of await readdir(root)) {
      await makeWritableForCleanup(path.join(root, child));
    }
    return;
  }
  if (!metadata.isSymbolicLink()) await chmod(root, 0o600);
}

async function exists(candidate: string): Promise<boolean> {
  return lstat(candidate).then(() => true, (error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return false;
    throw error;
  });
}

function assertOutputBoundary(
  workspace: string,
  outputRoot: string,
  allowExternalOutputForTests: boolean,
): void {
  const defaultRoot = path.join(workspace, ...DEFAULT_OUTPUT_RELATIVE_PATH.split("/"));
  if (allowExternalOutputForTests) {
    if (process.env.NODE_ENV !== "test" || !isInside(os.tmpdir(), outputRoot)) {
      throw new Error("外部 MCP candidate 输出只允许 NODE_ENV=test 的系统临时目录。");
    }
    return;
  }
  if (outputRoot !== defaultRoot && !isInside(defaultRoot, outputRoot)) {
    throw new Error(`正式 MCP candidate 只能写入工作区隐藏候选根：${defaultRoot}`);
  }
  for (const protectedPath of [
    workspace,
    path.join(workspace, "dist-mcp"),
    path.join(workspace, "src"),
    path.join(workspace, "scripts"),
    path.join(workspace, "tests"),
    path.join(workspace, "node_modules"),
  ]) {
    if (outputRoot === protectedPath || isInside(outputRoot, protectedPath)) {
      throw new Error(`MCP candidate 输出范围过宽或覆盖受保护路径：${outputRoot}`);
    }
  }
}

async function publishCandidate(
  outputRoot: string,
  temporaryCandidateRoot: string,
  receipt: ImmutableMcpRuntimeCandidateReceipt,
): Promise<{ candidateRoot: string; reused: boolean }> {
  const finalRoot = path.join(outputRoot, receipt.candidateId);
  const lockPath = `${finalRoot}.publish-lock`;
  const lock = await open(lockPath, "wx", 0o600);
  try {
    if (await exists(finalRoot)) {
      const existing = await verifyImmutableMcpRuntimeCandidate(finalRoot);
      if (existing.fingerprint !== receipt.fingerprint) {
        throw new Error(`同 candidateId 已存在不同 receipt：${finalRoot}`);
      }
      await makeWritableForCleanup(temporaryCandidateRoot);
      await rm(temporaryCandidateRoot, { recursive: true, force: true });
      return { candidateRoot: finalRoot, reused: true };
    }
    await sealImmutableMcpRuntimeCandidate(temporaryCandidateRoot);
    await rename(temporaryCandidateRoot, finalRoot);
    await verifyImmutableMcpRuntimeCandidate(finalRoot);
    return { candidateRoot: finalRoot, reused: false };
  } finally {
    await lock.close();
    await unlink(lockPath).catch(() => undefined);
  }
}

export async function buildImmutableMcpRuntimeCandidate(
  input: BuildImmutableMcpRuntimeCandidateInput = {},
): Promise<BuildImmutableMcpRuntimeCandidateResult> {
  const workspace = await realpath(path.resolve(
    input.workspace
      ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
  ));
  const outputRoot = path.resolve(
    input.outputRoot
      ?? path.join(workspace, ...DEFAULT_OUTPUT_RELATIVE_PATH.split("/")),
  );
  assertOutputBoundary(workspace, outputRoot, input.allowExternalOutputForTests === true);
  await mkdir(outputRoot, { recursive: true, mode: 0o700 });
  const canonicalOutputRoot = await realpath(outputRoot);

  const liveDistMcpRoot = path.join(workspace, "dist-mcp");
  const [sourceBefore, liveDistBefore] = await Promise.all([
    computeSourceDigest(workspace),
    runtimeTreeOrNull(liveDistMcpRoot),
  ]);
  // macOS 的 TMPDIR 路径很长，tsx 会在 TMPDIR 下建立 Unix socket；超过
  // sockaddr_un 上限会 EINVAL。stage 仍位于系统临时区，但 Darwin 使用短 /tmp。
  const stageTempBase = process.platform === "darwin" ? "/tmp" : os.tmpdir();
  const tempRoot = await realpath(await mkdtemp(path.join(stageTempBase, "aic-mcp-stage-")));
  const stageRoot = path.join(tempRoot, "workspace");
  const stageHome = path.join(tempRoot, "home");
  const stageTmp = path.join(tempRoot, "tmp");
  const temporaryCandidateRoot = await mkdtemp(path.join(canonicalOutputRoot, ".building-"));
  const commands: ImmutableMcpCandidateBuildCommandEvidence[] = [];
  let published = false;

  try {
    await Promise.all([
      mkdir(stageRoot, { recursive: true, mode: 0o700 }),
      mkdir(stageHome, { recursive: true, mode: 0o700 }),
      mkdir(stageTmp, { recursive: true, mode: 0o700 }),
    ]);
    const copiedFiles = await copySourceDigestInputs(workspace, stageRoot);
    if (copiedFiles !== sourceBefore.sourceFiles) {
      throw new Error(`隔离 stage 文件数 ${copiedFiles} 与 sourceDigest ${sourceBefore.sourceFiles} 不一致。`);
    }
    await copyDirectoryCow(path.join(workspace, "node_modules"), stageRoot);
    const stageBefore = await computeSourceDigest(stageRoot);
    if (!sameSourceIdentity(sourceBefore, stageBefore)) {
      throw new Error("隔离 stage 与 live sourceDigest 输入不一致。");
    }

    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: stageHome,
      TMPDIR: stageTmp,
      AI_CANVAS_REGISTRY_PATH: path.join(tempRoot, "projects.json"),
      AI_CANVAS_WORKSPACE: stageRoot,
    };
    delete environment.AI_CANVAS_RELEASE_MANIFEST_PATH;
    delete environment.AI_CANVAS_RECORDED_SOURCE_DIGEST;
    delete environment.AI_CANVAS_RECORDED_RUNTIME_ARTIFACT_SHA256;
    delete environment.AI_CANVAS_BUILD_TIMESTAMP;

    commands.push(await runBuildCommand("build:mcp", stageRoot, environment));
    commands.push(await runBuildCommand("build:identity", stageRoot, environment));

    const stageAfter = await computeSourceDigest(stageRoot);
    if (!sameSourceIdentity(stageBefore, stageAfter)) {
      throw new Error("隔离 stage 在 build:mcp + build:identity 期间发生源码漂移。");
    }
    const sourceBeforePublish = await computeSourceDigest(workspace);
    if (!sameSourceIdentity(sourceBefore, sourceBeforePublish)) {
      throw new Error("live 源码在候选构建期间漂移，拒绝发布 candidate。");
    }
    const liveDistBeforePublish = await runtimeTreeOrNull(liveDistMcpRoot);
    if (!sameRuntimeTree(liveDistBefore, liveDistBeforePublish)) {
      throw new Error("live dist-mcp 在候选构建期间变化，拒绝发布 candidate。");
    }

    await copyDirectoryCow(path.join(stageRoot, "dist-mcp"), temporaryCandidateRoot);
    await copyFile(
      path.join(stageRoot, "release-manifest.json"),
      path.join(temporaryCandidateRoot, "release-manifest.json"),
      fsConstants.COPYFILE_FICLONE,
    );
    const receipt = await createImmutableMcpRuntimeCandidateReceipt(temporaryCandidateRoot);
    if (receipt.sourceDigest !== sourceBefore.sourceDigest
      || receipt.sourceFiles !== sourceBefore.sourceFiles
      || receipt.sourceBytes !== sourceBefore.sourceBytes) {
      throw new Error("MCP candidate receipt 未绑定构建开始时的 live sourceDigest。");
    }
    await writeFile(
      path.join(temporaryCandidateRoot, "receipt.json"),
      serializeImmutableMcpRuntimeCandidateReceipt(receipt),
      { encoding: "utf8", flag: "wx", mode: 0o444 },
    );
    await verifyImmutableMcpRuntimeCandidate(temporaryCandidateRoot, {
      requireDirectoryName: false,
      requireReadOnly: false,
    });
    const publication = await publishCandidate(canonicalOutputRoot, temporaryCandidateRoot, receipt);
    published = true;

    const [sourceAfter, liveDistAfter] = await Promise.all([
      computeSourceDigest(workspace),
      runtimeTreeOrNull(liveDistMcpRoot),
    ]);
    if (!sameSourceIdentity(sourceBefore, sourceAfter)) {
      throw new Error("live 源码在候选发布前后发生变化；candidate 保留但不得切换。");
    }
    if (!sameRuntimeTree(liveDistBefore, liveDistAfter)) {
      throw new Error("live dist-mcp 在候选发布前后发生变化。");
    }
    const landed = await verifyImmutableMcpRuntimeCandidate(publication.candidateRoot);
    if (landed.fingerprint !== receipt.fingerprint) {
      throw new Error("落盘 MCP candidate receipt 与发布输入不一致。");
    }
    return {
      schemaVersion: 1,
      kind: "immutable-mcp-runtime-candidate-build-result",
      candidateRoot: publication.candidateRoot,
      reused: publication.reused,
      receipt: landed,
      commands,
      source: {
        before: sourceBefore.sourceDigest,
        stageBefore: stageBefore.sourceDigest,
        stageAfter: stageAfter.sourceDigest,
        after: sourceAfter.sourceDigest,
        unchanged: true,
      },
      liveDistMcp: {
        beforeFingerprint: liveDistBefore?.fingerprint ?? null,
        afterFingerprint: liveDistAfter?.fingerprint ?? null,
        unchanged: true,
      },
    };
  } finally {
    if (!published) {
      await makeWritableForCleanup(temporaryCandidateRoot).catch(() => undefined);
      await rm(temporaryCandidateRoot, { recursive: true, force: true }).catch(() => undefined);
    }
    await rm(tempRoot, { recursive: true, force: true });
  }
}

function parseCliArguments(argv: string[]): BuildImmutableMcpRuntimeCandidateInput {
  let outputRoot: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--output-root") {
      const value = argv[index + 1];
      if (!value) throw new Error("--output-root 缺少路径。");
      outputRoot = path.resolve(value);
      index += 1;
      continue;
    }
    throw new Error(`未知参数：${argument}`);
  }
  return outputRoot ? { outputRoot } : {};
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  const result = await buildImmutableMcpRuntimeCandidate(parseCliArguments(process.argv.slice(2)));
  const manifest = JSON.parse(await readFile(path.join(result.candidateRoot, "release-manifest.json"), "utf8")) as {
    fingerprint?: string;
  };
  process.stdout.write(`${JSON.stringify({
    ...result,
    releaseManifestFingerprint: manifest.fingerprint,
  }, null, 2)}\n`);
}
