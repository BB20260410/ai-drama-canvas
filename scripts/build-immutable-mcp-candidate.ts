/**
 * 在隔离 stage 中构建不可变 MCP 候选树。
 *
 * 该脚本绝不执行工作区的 `npm run build:mcp`，因为那个命令会先删除 live
 * `dist-mcp`。它逐项复制 computeSourceDigest 的同一输入集合，在 stage 内执行
 * build:mcp → build:identity，再把完整 dist-mcp 发布到只增不改的版本目录。
 */
import { constants as fsConstants, realpathSync } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
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
  inspectImmutableMcpRuntimeTree,
  type ImmutableMcpRuntimeCandidateReceipt,
  type ImmutableMcpRuntimeTreeIdentity,
} from "../src/core/immutable-mcp-runtime-candidate.js";
import {
  verifyPublishedImmutableMcpRuntimeCandidate,
  type ImmutableMcpCandidatePublicationRecord,
} from "../src/core/immutable-mcp-runtime-publication.js";
import { sanitizedMcpChildEnvironment } from "../src/core/current-mcp-runtime.js";
import {
  makeImmutableMcpCandidateTreeWritableForCleanup,
  prepareImmutableMcpCandidateStage,
  type ImmutableMcpCandidateBuildCommandEvidence,
} from "./lib/immutable-mcp-candidate-stage.js";
import {
  publishImmutableMcpCandidateCutover,
  verifyCommittedImmutableMcpCandidateDelivery,
} from "./lib/immutable-mcp-candidate-cutover.js";

export type { ImmutableMcpCandidateBuildCommandEvidence } from "./lib/immutable-mcp-candidate-stage.js";
export { publishImmutableMcpCandidateCutover } from "./lib/immutable-mcp-candidate-cutover.js";

const DEFAULT_OUTPUT_RELATIVE_PATH = ".aicanvas-runtime/mcp-candidates";
const DEFAULT_LAUNCHER_RELATIVE_ROOT = ".aicanvas-runtime/mcp-launcher";

export interface BuildImmutableMcpRuntimeCandidateInput {
  workspace?: string;
  outputRoot?: string;
  launcherRoot?: string;
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
  publication: ImmutableMcpCandidatePublicationRecord;
  launcher: {
    path: string;
    sha256: string;
    externalImports: string[];
  };
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

export function assertImmutableMcpCandidateOutputBoundary(
  workspace: string,
  outputRoot: string,
  allowExternalOutputForTests: boolean,
): void {
  const defaultRoot = path.join(workspace, ...DEFAULT_OUTPUT_RELATIVE_PATH.split("/"));
  if (allowExternalOutputForTests) {
    if (process.env.NODE_ENV !== "test" || !isInside(realpathSync.native(os.tmpdir()), outputRoot)) {
      throw new Error("外部 MCP candidate 输出只允许 NODE_ENV=test 的系统临时目录。");
    }
    return;
  }
  if (outputRoot !== defaultRoot) {
    throw new Error(`正式 MCP candidate 只能写入固定根：${defaultRoot}`);
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

function assertLauncherBoundary(
  workspace: string,
  outputRoot: string,
  launcherRoot: string,
  allowExternalOutputForTests: boolean,
): void {
  const defaultRoot = path.join(workspace, ...DEFAULT_LAUNCHER_RELATIVE_ROOT.split("/"));
  if (allowExternalOutputForTests) {
    if (process.env.NODE_ENV !== "test"
      || !isInside(realpathSync.native(os.tmpdir()), launcherRoot)
      || !(launcherRoot === path.join(outputRoot, ".launcher") || isInside(outputRoot, launcherRoot))) {
      throw new Error("测试 MCP launcher 只允许写入外部 candidate 临时根内部。");
    }
    return;
  }
  if (launcherRoot !== defaultRoot) {
    throw new Error(`正式 MCP launcher 只能写入固定根：${defaultRoot}`);
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
  const allowExternalOutputForTests = input.allowExternalOutputForTests === true;
  const launcherRoot = path.resolve(input.launcherRoot
    ?? (allowExternalOutputForTests
      ? path.join(outputRoot, ".launcher")
      : path.join(workspace, ...DEFAULT_LAUNCHER_RELATIVE_ROOT.split("/"))));
  assertImmutableMcpCandidateOutputBoundary(workspace, outputRoot, allowExternalOutputForTests);
  assertLauncherBoundary(workspace, outputRoot, launcherRoot, allowExternalOutputForTests);
  await mkdir(outputRoot, { recursive: true, mode: 0o700 });
  const canonicalOutputRoot = await realpath(outputRoot);
  if (canonicalOutputRoot !== outputRoot) {
    throw new Error(`MCP candidate 根必须是规范真实目录：${outputRoot}`);
  }

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
  const stageTmp = path.join(tempRoot, "tmp");
  const stageNpmCache = path.join(tempRoot, "npm-cache");
  const stageHome = path.join(tempRoot, "home");
  const stageNpmUserConfig = path.join(tempRoot, "npmrc");
  const temporaryCandidateRoot = await mkdtemp(path.join(canonicalOutputRoot, ".building-"));
  let published = false;
  let tempRootFinalized = false;

  try {
    await Promise.all([
      mkdir(stageRoot, { recursive: true, mode: 0o700 }),
      mkdir(stageTmp, { recursive: true, mode: 0o700 }),
      mkdir(stageNpmCache, { recursive: true, mode: 0o700 }),
      mkdir(stageHome, { recursive: true, mode: 0o700 }),
    ]);
    await writeFile(stageNpmUserConfig, "", { encoding: "utf8", flag: "wx", mode: 0o600 });
    const environment: NodeJS.ProcessEnv = {
      ...sanitizedMcpChildEnvironment(process.env),
      HOME: stageHome,
      TMPDIR: stageTmp,
      npm_config_cache: stageNpmCache,
      npm_config_userconfig: stageNpmUserConfig,
      npm_config_registry: "https://registry.npmjs.org",
      AI_CANVAS_REGISTRY_PATH: path.join(tempRoot, "projects.json"),
      AI_CANVAS_WORKSPACE: stageRoot,
    };
    delete environment.AI_CANVAS_RELEASE_MANIFEST_PATH;
    delete environment.AI_CANVAS_RECORDED_SOURCE_DIGEST;
    delete environment.AI_CANVAS_RECORDED_RUNTIME_ARTIFACT_SHA256;
    delete environment.AI_CANVAS_BUILD_TIMESTAMP;

    const prepared = await prepareImmutableMcpCandidateStage({
      workspace,
      stageRoot,
      temporaryRoot: tempRoot,
      temporaryCandidateRoot,
      environment,
      sourceBefore,
      copySourceInputs: async () => {
        const copiedFiles = await copySourceDigestInputs(workspace, stageRoot);
        if (copiedFiles !== sourceBefore.sourceFiles) {
          throw new Error(`隔离 stage 文件数 ${copiedFiles} 与 sourceDigest ${sourceBefore.sourceFiles} 不一致。`);
        }
      },
      verifyStageSourceBefore: async () => {
        const stageBefore = await computeSourceDigest(stageRoot);
        if (!sameSourceIdentity(sourceBefore, stageBefore)) {
          throw new Error("隔离 stage 与 live sourceDigest 输入不一致。");
        }
        return stageBefore;
      },
      verifyStageSourceAfter: async (stageBefore) => {
        const stageAfter = await computeSourceDigest(stageRoot);
        if (!sameSourceIdentity(stageBefore, stageAfter)) {
          throw new Error("隔离 stage 在 build:mcp + build:identity 期间发生源码漂移。");
        }
        return stageAfter;
      },
      verifyLiveSourceBeforePayload: async () => {
        const sourceBeforePublish = await computeSourceDigest(workspace);
        if (!sameSourceIdentity(sourceBefore, sourceBeforePublish)) {
          throw new Error("live 源码在候选构建期间漂移，拒绝发布 candidate。");
        }
        const liveDistBeforePublish = await runtimeTreeOrNull(liveDistMcpRoot);
        if (!sameRuntimeTree(liveDistBefore, liveDistBeforePublish)) {
          throw new Error("live dist-mcp 在候选构建期间变化，拒绝发布 candidate。");
        }
      },
    });
    const { commands, stageBefore, stageAfter, receipt, publication: publicationRecord, launcher } = prepared;
    let sourceAfter = sourceBefore;
    let liveDistAfter = liveDistBefore;
    const publication = await publishImmutableMcpCandidateCutover(
      canonicalOutputRoot,
      launcherRoot,
      launcher.bundlePath,
      launcher.sha256,
      temporaryCandidateRoot,
      receipt,
      publicationRecord,
      {
        beforeLauncherCutover: async () => {
          [sourceAfter, liveDistAfter] = await Promise.all([
            computeSourceDigest(workspace),
            runtimeTreeOrNull(liveDistMcpRoot),
          ]);
          if (!sameSourceIdentity(sourceBefore, sourceAfter)) {
            throw new Error("live 源码在原子 launcher cutover 前发生变化，旧 launcher 保持不变。");
          }
          if (!sameRuntimeTree(liveDistBefore, liveDistAfter)) {
            throw new Error("live dist-mcp 在原子 launcher cutover 前发生变化，旧 launcher 保持不变。");
          }
        },
      },
    );
    published = true;

    const landed = await verifyCommittedImmutableMcpCandidateDelivery({
      committedResult: publication,
      verifyLanded: async () => {
        const verified = await verifyPublishedImmutableMcpRuntimeCandidate(
          publication.candidateRoot,
          publication.publication,
          { launcherPath: publication.launcherPath },
        );
        if (verified.fingerprint !== receipt.fingerprint) {
          throw new Error("落盘 MCP candidate receipt 与发布输入不一致。");
        }
        return verified;
      },
      cleanupStage: async () => {
        try {
          await rm(tempRoot, { recursive: true, force: true });
        } finally {
          tempRootFinalized = true;
        }
      },
    });
    return {
      schemaVersion: 1,
      kind: "immutable-mcp-runtime-candidate-build-result",
      candidateRoot: publication.candidateRoot,
      reused: publication.reused,
      receipt: landed,
      publication: publication.publication,
      launcher: {
        path: publication.launcherPath,
        sha256: launcher.sha256,
        externalImports: launcher.externalImports,
      },
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
      await makeImmutableMcpCandidateTreeWritableForCleanup(temporaryCandidateRoot).catch(() => undefined);
      await rm(temporaryCandidateRoot, { recursive: true, force: true }).catch(() => undefined);
    }
    if (!tempRootFinalized) await rm(tempRoot, { recursive: true, force: true });
  }
}

export function parseImmutableMcpCandidateBuildArguments(
  argv: string[],
): BuildImmutableMcpRuntimeCandidateInput {
  if (argv.length) throw new Error(`未知参数：${argv[0]}`);
  return {};
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  const result = await buildImmutableMcpRuntimeCandidate(
    parseImmutableMcpCandidateBuildArguments(process.argv.slice(2)),
  );
  const manifest = JSON.parse(await readFile(path.join(result.candidateRoot, "release-manifest.json"), "utf8")) as {
    fingerprint?: string;
  };
  process.stdout.write(`${JSON.stringify({
    ...result,
    releaseManifestFingerprint: manifest.fingerprint,
  }, null, 2)}\n`);
}
