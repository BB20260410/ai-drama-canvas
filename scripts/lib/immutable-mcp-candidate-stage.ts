import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { builtinModules } from "node:module";
import path from "node:path";
import {
  createImmutableMcpRuntimeCandidateReceipt,
  serializeImmutableMcpRuntimeCandidateReceipt,
  verifyImmutableMcpRuntimeCandidate,
  type ImmutableMcpRuntimeCandidateReceipt,
} from "../../src/core/immutable-mcp-runtime-candidate.js";
import {
  createImmutableMcpCandidatePublicationRecord,
  sha256ImmutableMcpFile,
  type ImmutableMcpCandidatePublicationRecord,
} from "../../src/core/immutable-mcp-runtime-publication.js";
import {
  assertNpmProductionDependencyHealth,
  type NpmLsJson,
  type NpmProductionDependencyHealthSummary,
  type PackageLockJson,
} from "./npm-production-dependency-health.js";

const RUNTIME_GUARD_SOURCE_RELATIVE_PATH = "scripts/mcp-candidate-runtime-guard.mjs";
const COMMAND_TIMEOUT_MS = 10 * 60_000;

export interface ImmutableMcpCandidateBuildCommandEvidence {
  name: "npm:ci" | "build:mcp" | "build:identity" | "build:launcher" | "npm:prune-production" | "npm:ls-production" | "runtime:smoke";
  executable: string;
  args: string[];
  cwd: string;
  exitCode: 0;
  stdoutTail: string;
  stderrTail: string;
  productionDependencyHealth?: NpmProductionDependencyHealthSummary;
}

export const IMMUTABLE_MCP_CANDIDATE_STAGE_STEP_ORDER = [
  "copy-source-inputs",
  "verify-stage-source-before",
  "npm-ci",
  "build-launcher",
  "build-mcp",
  "build-identity",
  "verify-stage-source-after",
  "verify-live-source-before-payload",
  "npm-prune-production",
  "npm-ls-production",
  "remove-node-modules-bin",
  "copy-candidate-payload",
  "create-candidate-receipt",
  "verify-candidate-payload",
  "runtime-smoke",
  "create-publication-record",
] as const;

export type ImmutableMcpCandidateStageStep = (typeof IMMUTABLE_MCP_CANDIDATE_STAGE_STEP_ORDER)[number];

export async function runImmutableMcpCandidateStageSteps(
  operations: Record<ImmutableMcpCandidateStageStep, () => Promise<void>>,
): Promise<void> {
  for (const step of IMMUTABLE_MCP_CANDIDATE_STAGE_STEP_ORDER) await operations[step]();
}

export interface ImmutableMcpCandidateSourceIdentity {
  sourceDigest: string;
  sourceFiles: number;
  sourceBytes: number;
}

export interface PrepareImmutableMcpCandidateStageInput {
  workspace: string;
  stageRoot: string;
  temporaryRoot: string;
  temporaryCandidateRoot: string;
  environment: NodeJS.ProcessEnv;
  sourceBefore: ImmutableMcpCandidateSourceIdentity;
  copySourceInputs(): Promise<void>;
  verifyStageSourceBefore(): Promise<ImmutableMcpCandidateSourceIdentity>;
  verifyStageSourceAfter(
    stageBefore: ImmutableMcpCandidateSourceIdentity,
  ): Promise<ImmutableMcpCandidateSourceIdentity>;
  verifyLiveSourceBeforePayload(): Promise<void>;
}

export interface PreparedImmutableMcpCandidateStage {
  commands: ImmutableMcpCandidateBuildCommandEvidence[];
  stageBefore: ImmutableMcpCandidateSourceIdentity;
  stageAfter: ImmutableMcpCandidateSourceIdentity;
  receipt: ImmutableMcpRuntimeCandidateReceipt;
  publication: ImmutableMcpCandidatePublicationRecord;
  launcher: {
    bundlePath: string;
    sha256: string;
    externalImports: string[];
  };
}

function tail(value: string, maxLines = 20, maxCharacters = 8_000): string {
  const selected = value.trim().split(/\r?\n/u).slice(-maxLines).join("\n");
  return selected.length > maxCharacters ? selected.slice(-maxCharacters) : selected;
}

async function runCommand(
  name: ImmutableMcpCandidateBuildCommandEvidence["name"],
  executable: string,
  args: string[],
  stageRoot: string,
  environment: NodeJS.ProcessEnv,
  validateStdout?: (stdout: string) => NpmProductionDependencyHealthSummary,
): Promise<ImmutableMcpCandidateBuildCommandEvidence> {
  return new Promise((resolve, reject) => {
    execFile(
      executable,
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
          reject(new Error(`隔离 MCP candidate ${name} 失败：${error.message}\n${stderrTail || stdoutTail}`));
          return;
        }
        try {
          const productionDependencyHealth = validateStdout?.(stdout);
          resolve({
            name,
            executable,
            args,
            cwd: stageRoot,
            exitCode: 0,
            stdoutTail,
            stderrTail,
            ...(productionDependencyHealth ? { productionDependencyHealth } : {}),
          });
        } catch (validationError) {
          reject(new Error(`隔离 MCP candidate ${name} 语义校验失败：${validationError instanceof Error ? validationError.message : String(validationError)}`));
        }
      },
    );
  });
}

async function runNpmCommand(
  name: ImmutableMcpCandidateBuildCommandEvidence["name"],
  args: string[],
  stageRoot: string,
  environment: NodeJS.ProcessEnv,
  validateStdout?: (stdout: string) => NpmProductionDependencyHealthSummary,
): Promise<ImmutableMcpCandidateBuildCommandEvidence> {
  return runCommand(name, "/usr/bin/env", ["npm", ...args], stageRoot, environment, validateStdout);
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

async function buildLauncherBundle(
  stageRoot: string,
  temporaryRoot: string,
  environment: NodeJS.ProcessEnv,
): Promise<PreparedImmutableMcpCandidateStage["launcher"] & { command: ImmutableMcpCandidateBuildCommandEvidence }> {
  const bundlePath = path.join(temporaryRoot, "current-mcp-launcher.mjs");
  const metafilePath = path.join(temporaryRoot, "current-mcp-launcher-meta.json");
  const executable = path.join(stageRoot, "node_modules", ".bin", "esbuild");
  const command = await runCommand("build:launcher", executable, [
    path.join(stageRoot, "scripts", "launch-current-mcp-candidate.ts"),
    "--bundle",
    "--platform=node",
    "--target=node22",
    "--format=esm",
    "--packages=bundle",
    "--banner:js=import { createRequire as __aicanvasCreateRequire } from 'node:module'; const require = __aicanvasCreateRequire(import.meta.url);",
    "--legal-comments=none",
    `--metafile=${metafilePath}`,
    `--outfile=${bundlePath}`,
  ], stageRoot, environment);
  const metafile = JSON.parse(await readFile(metafilePath, "utf8")) as {
    outputs?: Record<string, { imports?: Array<{ path?: string; external?: boolean }> }>;
  };
  const externalImports = [...new Set(Object.values(metafile.outputs ?? {})
    .flatMap((output) => output.imports ?? [])
    .filter((entry) => entry.external)
    .map((entry) => entry.path ?? ""))].sort((left, right) => left.localeCompare(right, "en"));
  const builtinSpecifiers = new Set([
    ...builtinModules,
    ...builtinModules.map((entry) => entry.startsWith("node:") ? entry : `node:${entry}`),
  ]);
  const invalidExternal = externalImports.filter((entry) => !builtinSpecifiers.has(entry));
  if (invalidExternal.length) {
    throw new Error(`稳定 MCP launcher 仍含非 builtin 外部依赖：${invalidExternal.join("、")}`);
  }
  return { command, bundlePath, sha256: await sha256ImmutableMcpFile(bundlePath), externalImports };
}

async function verifyCandidateRuntimeSmoke(
  candidateRoot: string,
  environment: NodeJS.ProcessEnv,
): Promise<ImmutableMcpCandidateBuildCommandEvidence> {
  const smoke = [
    'const [{ default: sharp }] = await Promise.all([import("sharp"), import("zod"), import("chokidar"), import("@modelcontextprotocol/sdk/server/index.js")]);',
    'const png = await sharp({ create: { width: 1, height: 1, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();',
    'if (png.length < 20) throw new Error("sharp PNG smoke 为空");',
  ].join("\n");
  return runCommand("runtime:smoke", process.execPath, [
    "--import",
    path.join(candidateRoot, "runtime-guard.mjs"),
    "--input-type=module",
    "--eval",
    smoke,
  ], candidateRoot, environment);
}

async function removeNodeModulesBinDirectories(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory() && entry.name === ".bin") {
      await rm(absolutePath, { recursive: true, force: true });
      continue;
    }
    if (entry.isDirectory()) await removeNodeModulesBinDirectories(absolutePath);
  }
}

export async function makeImmutableMcpCandidateTreeWritableForCleanup(root: string): Promise<void> {
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
      await makeImmutableMcpCandidateTreeWritableForCleanup(path.join(root, child));
    }
    return;
  }
  if (!metadata.isSymbolicLink()) await chmod(root, 0o600);
}

export async function prepareImmutableMcpCandidateStage(
  input: PrepareImmutableMcpCandidateStageInput,
): Promise<PreparedImmutableMcpCandidateStage> {
  const commands: ImmutableMcpCandidateBuildCommandEvidence[] = [];
  let stageBefore: ImmutableMcpCandidateSourceIdentity | undefined;
  let stageAfter: ImmutableMcpCandidateSourceIdentity | undefined;
  let receipt: ImmutableMcpRuntimeCandidateReceipt | undefined;
  let publication: ImmutableMcpCandidatePublicationRecord | undefined;
  let launcher: Awaited<ReturnType<typeof buildLauncherBundle>> | undefined;

  await runImmutableMcpCandidateStageSteps({
    "copy-source-inputs": async () => {
      await input.copySourceInputs();
    },
    "verify-stage-source-before": async () => {
      stageBefore = await input.verifyStageSourceBefore();
    },
    "npm-ci": async () => {
      commands.push(await runNpmCommand("npm:ci", [
        "ci", "--include=dev", "--ignore-scripts", "--no-audit", "--no-fund",
      ], input.stageRoot, input.environment));
    },
    "build-launcher": async () => {
      launcher = await buildLauncherBundle(input.stageRoot, input.temporaryRoot, input.environment);
      commands.push(launcher.command);
    },
    "build-mcp": async () => {
      commands.push(await runNpmCommand("build:mcp", ["run", "build:mcp"], input.stageRoot, input.environment));
    },
    "build-identity": async () => {
      commands.push(await runNpmCommand("build:identity", ["run", "build:identity"], input.stageRoot, input.environment));
    },
    "verify-stage-source-after": async () => {
      if (!stageBefore) throw new Error("MCP candidate stageBefore 未建立。");
      stageAfter = await input.verifyStageSourceAfter(stageBefore);
    },
    "verify-live-source-before-payload": input.verifyLiveSourceBeforePayload,
    "npm-prune-production": async () => {
      commands.push(await runNpmCommand("npm:prune-production", [
        "prune", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund",
      ], input.stageRoot, input.environment));
    },
    "npm-ls-production": async () => {
      const lockfile = JSON.parse(await readFile(path.join(input.stageRoot, "package-lock.json"), "utf8")) as PackageLockJson;
      commands.push(await runNpmCommand("npm:ls-production", [
        "ls", "--omit=dev", "--all", "--json",
      ], input.stageRoot, input.environment, (stdout) => assertNpmProductionDependencyHealth(
        JSON.parse(stdout) as NpmLsJson,
        lockfile,
      )));
    },
    "remove-node-modules-bin": async () => {
      await removeNodeModulesBinDirectories(path.join(input.stageRoot, "node_modules"));
    },
    "copy-candidate-payload": async () => {
      await copyDirectoryCow(path.join(input.stageRoot, "dist-mcp"), input.temporaryCandidateRoot);
      await copyDirectoryCow(path.join(input.stageRoot, "node_modules"), input.temporaryCandidateRoot);
      for (const relativePath of ["package.json", "package-lock.json", RUNTIME_GUARD_SOURCE_RELATIVE_PATH]) {
        await copyFile(
          path.join(input.stageRoot, relativePath),
          path.join(input.temporaryCandidateRoot, path.basename(relativePath) === "mcp-candidate-runtime-guard.mjs"
            ? "runtime-guard.mjs"
            : path.basename(relativePath)),
          fsConstants.COPYFILE_FICLONE,
        );
      }
      await copyFile(
        path.join(input.stageRoot, "release-manifest.json"),
        path.join(input.temporaryCandidateRoot, "release-manifest.json"),
        fsConstants.COPYFILE_FICLONE,
      );
    },
    "create-candidate-receipt": async () => {
      receipt = await createImmutableMcpRuntimeCandidateReceipt(input.temporaryCandidateRoot);
      if (receipt.sourceDigest !== input.sourceBefore.sourceDigest
        || receipt.sourceFiles !== input.sourceBefore.sourceFiles
        || receipt.sourceBytes !== input.sourceBefore.sourceBytes) {
        throw new Error("MCP candidate receipt 未绑定构建开始时的 live sourceDigest。");
      }
      await writeFile(
        path.join(input.temporaryCandidateRoot, "receipt.json"),
        serializeImmutableMcpRuntimeCandidateReceipt(receipt),
        { encoding: "utf8", flag: "wx", mode: 0o444 },
      );
    },
    "verify-candidate-payload": async () => {
      await verifyImmutableMcpRuntimeCandidate(input.temporaryCandidateRoot, {
        requireDirectoryName: false,
        requireReadOnly: false,
      });
    },
    "runtime-smoke": async () => {
      commands.push(await verifyCandidateRuntimeSmoke(input.temporaryCandidateRoot, input.environment));
    },
    "create-publication-record": async () => {
      if (!receipt || !launcher) throw new Error("MCP candidate stage 内部状态不完整。");
      publication = await createImmutableMcpCandidatePublicationRecord(input.temporaryCandidateRoot, {
        launcherSha256: launcher.sha256,
        publishedAt: receipt.builtAt,
        requireDirectoryName: false,
        requireReadOnly: false,
      });
    },
  });

  if (!stageBefore || !stageAfter || !receipt || !publication || !launcher) {
    throw new Error("MCP candidate stage 编排未产生完整结果。");
  }
  return {
    commands,
    stageBefore,
    stageAfter,
    receipt,
    publication,
    launcher: {
      bundlePath: launcher.bundlePath,
      sha256: launcher.sha256,
      externalImports: launcher.externalImports,
    },
  };
}
