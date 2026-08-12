import { constants as fsConstants } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import {
  sealImmutableMcpRuntimeCandidate,
  verifyImmutableMcpRuntimeCandidate,
  type ImmutableMcpRuntimeCandidateReceipt,
} from "../../src/core/immutable-mcp-runtime-candidate.js";
import {
  IMMUTABLE_MCP_PUBLICATION_DIRECTORY,
  immutableMcpPublicationPath,
  readImmutableMcpCandidatePublicationRecord,
  serializeImmutableMcpCandidatePublicationRecord,
  sha256ImmutableMcpFile,
  verifyPublishedImmutableMcpRuntimeCandidate,
  type ImmutableMcpCandidatePublicationRecord,
} from "../../src/core/immutable-mcp-runtime-publication.js";
import { withImmutableMcpPublicationLock } from "../../src/core/immutable-mcp-publication-lock.js";
import { makeImmutableMcpCandidateTreeWritableForCleanup } from "./immutable-mcp-candidate-stage.js";

export interface ImmutableMcpCandidateCutoverOperations<StagedLauncher, PublicationResult> {
  stageLauncher(): Promise<StagedLauncher>;
  withPublicationLock<T>(callback: () => Promise<T>): Promise<T>;
  validateCurrentLauncher(stagedLauncher: StagedLauncher): Promise<void>;
  publishCandidateAndPublication(stagedLauncher: StagedLauncher): Promise<PublicationResult>;
  verifyStagedLauncher(stagedLauncher: StagedLauncher): Promise<void>;
  beforeLauncherCutover(stagedLauncher: StagedLauncher): Promise<void>;
  renameLauncher(stagedLauncher: StagedLauncher): Promise<void>;
  cleanupStagedLauncher(stagedLauncher: StagedLauncher): Promise<void>;
}

export class ImmutableMcpCandidateCutoverCommittedError<PublicationResult = unknown> extends Error {
  readonly code = "IMMUTABLE_MCP_CUTOVER_COMMITTED_LOCK_RELEASE_FAILED" as const;
  readonly committed = true as const;
  readonly result: PublicationResult;

  constructor(result: PublicationResult, cause: unknown) {
    super("稳定 MCP launcher 已提交，但提交后验证或终结失败；禁止自动重试。", { cause });
    this.name = "ImmutableMcpCandidateCutoverCommittedError";
    this.result = result;
  }
}

export async function verifyCommittedImmutableMcpCandidateDelivery<PublicationResult, LandedResult>(input: {
  committedResult: PublicationResult;
  verifyLanded(): Promise<LandedResult>;
  cleanupStage(): Promise<void>;
}): Promise<LandedResult> {
  let landed: LandedResult | undefined;
  let failure: unknown;
  try {
    landed = await input.verifyLanded();
  } catch (error) {
    failure = error;
  }
  try {
    await input.cleanupStage();
  } catch (cleanupError) {
    failure = failure
      ? new AggregateError([failure, cleanupError], "MCP committed 交付终结同时发生多个错误")
      : cleanupError;
  }
  if (failure) {
    throw new ImmutableMcpCandidateCutoverCommittedError(input.committedResult, failure);
  }
  return landed as LandedResult;
}

export async function runImmutableMcpCandidateCutoverTransaction<StagedLauncher, PublicationResult>(
  operations: ImmutableMcpCandidateCutoverOperations<StagedLauncher, PublicationResult>,
): Promise<PublicationResult> {
  const stagedLauncher = await operations.stageLauncher();
  let committedResult: PublicationResult | undefined;
  let launcherCommitted = false;
  let result: PublicationResult | undefined;
  let failure: unknown;
  try {
    result = await operations.withPublicationLock(async () => {
      await operations.validateCurrentLauncher(stagedLauncher);
      const publication = await operations.publishCandidateAndPublication(stagedLauncher);
      await operations.verifyStagedLauncher(stagedLauncher);
      await operations.beforeLauncherCutover(stagedLauncher);
      // 这是唯一可见 launcher 切换点；失败时旧 launcher 保持不变。
      await operations.renameLauncher(stagedLauncher);
      committedResult = publication;
      launcherCommitted = true;
      return publication;
    });
  } catch (error) {
    failure = launcherCommitted
      ? new ImmutableMcpCandidateCutoverCommittedError(committedResult as PublicationResult, error)
      : error;
  }
  try {
    await operations.cleanupStagedLauncher(stagedLauncher);
  } catch (cleanupError) {
    const cause = failure
      ? new AggregateError([failure, cleanupError], "MCP cutover 终结同时发生多个错误")
      : cleanupError;
    failure = launcherCommitted
      ? new ImmutableMcpCandidateCutoverCommittedError(committedResult as PublicationResult, cause)
      : cause;
  }
  if (failure) throw failure;
  return result as PublicationResult;
}

async function exists(candidate: string): Promise<boolean> {
  return lstat(candidate).then(() => true, (error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return false;
    throw error;
  });
}

async function stageStableLauncher(
  launcherRoot: string,
  bundlePath: string,
  expectedSha256: string,
): Promise<{ temporaryDirectory: string; temporaryPath: string; finalPath: string }> {
  await mkdir(launcherRoot, { recursive: true, mode: 0o700 });
  const canonicalRoot = await realpath(launcherRoot);
  if (canonicalRoot !== path.resolve(launcherRoot)) {
    throw new Error(`稳定 MCP launcher 根必须是规范真实目录：${launcherRoot}`);
  }
  const temporaryDirectory = await mkdtemp(path.join(canonicalRoot, ".publishing-"));
  const temporaryPath = path.join(temporaryDirectory, "current.mjs");
  const finalPath = path.join(canonicalRoot, "current.mjs");
  try {
    await copyFile(bundlePath, temporaryPath, fsConstants.COPYFILE_FICLONE);
    await chmod(temporaryPath, 0o444);
    if (await sha256ImmutableMcpFile(temporaryPath) !== expectedSha256) {
      throw new Error("待发布稳定 MCP launcher SHA-256 与构建输出不一致。");
    }
    return { temporaryDirectory, temporaryPath, finalPath };
  } catch (error) {
    await rm(temporaryDirectory, { recursive: true, force: true });
    throw error;
  }
}

async function publishCandidateAndPublication(
  outputRoot: string,
  temporaryCandidateRoot: string,
  receipt: ImmutableMcpRuntimeCandidateReceipt,
  publication: ImmutableMcpCandidatePublicationRecord,
): Promise<{ candidateRoot: string; reused: boolean; publication: ImmutableMcpCandidatePublicationRecord }> {
  const finalRoot = path.join(outputRoot, receipt.candidateId);
  const publicationRoot = path.join(outputRoot, IMMUTABLE_MCP_PUBLICATION_DIRECTORY);
  await mkdir(publicationRoot, { recursive: true, mode: 0o700 });
  if (await realpath(publicationRoot) !== publicationRoot) {
    throw new Error(`MCP publication 根必须是规范真实目录：${publicationRoot}`);
  }
  const publicationPath = immutableMcpPublicationPath(outputRoot, receipt.candidateId);
  let reused = false;
  if (await exists(finalRoot)) {
    const existing = await verifyImmutableMcpRuntimeCandidate(finalRoot);
    if (existing.fingerprint !== receipt.fingerprint) {
      throw new Error(`同 candidateId 已存在不同 receipt：${finalRoot}`);
    }
    await verifyPublishedImmutableMcpRuntimeCandidate(finalRoot, publication, {
      launcherSha256: publication.launcherSha256,
    });
    await makeImmutableMcpCandidateTreeWritableForCleanup(temporaryCandidateRoot);
    await rm(temporaryCandidateRoot, { recursive: true, force: true });
    reused = true;
  } else {
    await sealImmutableMcpRuntimeCandidate(temporaryCandidateRoot);
    await rename(temporaryCandidateRoot, finalRoot);
    await verifyImmutableMcpRuntimeCandidate(finalRoot);
  }
  if (await exists(publicationPath)) {
    const existingPublication = await readImmutableMcpCandidatePublicationRecord(publicationPath);
    if (existingPublication.fingerprint !== publication.fingerprint) {
      throw new Error(`同 candidateId 已存在不同 publication：${publicationPath}`);
    }
  } else {
    const temporaryPublicationDirectory = await mkdtemp(path.join(publicationRoot, ".publishing-"));
    const temporaryPublicationPath = path.join(temporaryPublicationDirectory, `${receipt.candidateId}.json`);
    try {
      await writeFile(
        temporaryPublicationPath,
        serializeImmutableMcpCandidatePublicationRecord(publication),
        { encoding: "utf8", flag: "wx", mode: 0o444 },
      );
      await rename(temporaryPublicationPath, publicationPath);
    } finally {
      await rm(temporaryPublicationDirectory, { recursive: true, force: true });
    }
  }
  const landedPublication = await readImmutableMcpCandidatePublicationRecord(publicationPath);
  await verifyPublishedImmutableMcpRuntimeCandidate(finalRoot, landedPublication, {
    launcherSha256: publication.launcherSha256,
  });
  return { candidateRoot: finalRoot, reused, publication: landedPublication };
}

export async function publishImmutableMcpCandidateCutover(
  outputRoot: string,
  launcherRoot: string,
  launcherBundlePath: string,
  launcherSha256: string,
  temporaryCandidateRoot: string,
  receipt: ImmutableMcpRuntimeCandidateReceipt,
  publication: ImmutableMcpCandidatePublicationRecord,
  options: { beforeLauncherCutover?: () => Promise<void> } = {},
): Promise<{
  candidateRoot: string;
  reused: boolean;
  publication: ImmutableMcpCandidatePublicationRecord;
  launcherPath: string;
}> {
  if (publication.launcherSha256 !== launcherSha256) {
    throw new Error("MCP publication 绑定的 launcher SHA-256 与 cutover 输入不一致。");
  }
  const result = await runImmutableMcpCandidateCutoverTransaction({
    stageLauncher: () => stageStableLauncher(launcherRoot, launcherBundlePath, launcherSha256),
    withPublicationLock: (callback) => withImmutableMcpPublicationLock(outputRoot, callback),
    validateCurrentLauncher: async (stagedLauncher) => {
      if (await exists(stagedLauncher.finalPath)) {
        const currentLauncher = await lstat(stagedLauncher.finalPath);
        if (!currentLauncher.isFile()
          || currentLauncher.isSymbolicLink()
          || currentLauncher.nlink !== 1
          || await realpath(stagedLauncher.finalPath) !== stagedLauncher.finalPath) {
          throw new Error(`现有稳定 MCP launcher 不是单链接规范真实文件：${stagedLauncher.finalPath}`);
        }
      }
    },
    publishCandidateAndPublication: async (stagedLauncher) => ({
      ...await publishCandidateAndPublication(
        outputRoot,
        temporaryCandidateRoot,
        receipt,
        publication,
      ),
      launcherPath: stagedLauncher.finalPath,
    }),
    verifyStagedLauncher: async (stagedLauncher) => {
      if (await sha256ImmutableMcpFile(stagedLauncher.temporaryPath) !== launcherSha256) {
        throw new Error("稳定 MCP launcher 在 cutover 前发生漂移。");
      }
    },
    beforeLauncherCutover: async () => { await options.beforeLauncherCutover?.(); },
    renameLauncher: async (stagedLauncher) => {
      await rename(stagedLauncher.temporaryPath, stagedLauncher.finalPath);
    },
    cleanupStagedLauncher: async (stagedLauncher) => {
      await rm(stagedLauncher.temporaryDirectory, { recursive: true, force: true });
    },
  });
  return result;
}
