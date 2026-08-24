import { createHash } from "node:crypto";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { removeOwnedTemporaryFixtureRoot } from "./lib/owned-fixture-root.js";

const execFileAsync = promisify(execFile);
const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packagedExecutable = path.resolve(process.argv[2] ?? "");
if (!process.argv[2] || !path.isAbsolute(process.argv[2])) {
  throw new Error("必须传入当前源码 packaged App 的绝对可执行路径。 ");
}
await access(packagedExecutable);

const timestamp = new Date().toISOString().replace(/[-:.]/gu, "");
const runId = `native-media-drag-physical-${timestamp}-${process.pid}`;
const evidenceRoot = path.join(workspace, "docs", "evidence");
const evidencePath = path.join(evidenceRoot, `${runId}.json`);
const coreEvidencePath = path.join(evidenceRoot, `${runId}-core.json`);
const finderScreenshot = path.join(evidenceRoot, `${runId}-finder.png`);
const receiverScreenshot = path.join(evidenceRoot, `${runId}-receiver.png`);
const controlRoot = await mkdtemp(path.join(os.tmpdir(), "ai-canvas-native-drag-run-"));
const sessionPath = path.join(controlRoot, "session.json");
const finderTarget = path.join(controlRoot, "finder-drop");
const receiverTarget = path.join(controlRoot, "receiver-drop");
const receiverReadyPath = path.join(controlRoot, "receiver-ready.json");
const receiverReceiptPath = path.join(controlRoot, "receiver-receipt.json");
const receiverExecutable = path.join(controlRoot, "native-drop-receiver");
const receiverSource = path.join(workspace, "scripts", "native-media-drag-drop-receiver.swift");
const tsxExecutable = path.join(workspace, "node_modules", ".bin", "tsx");
const cliclickExecutable = "/opt/homebrew/bin/cliclick";
const NATIVE_DRAG_RUNTIME_OWNER = "native-media-drag-physical-harness";

await mkdir(evidenceRoot, { recursive: true });
await Promise.all([finderTarget, receiverTarget].map((directory) => mkdir(directory, { recursive: true })));
for (const output of [evidencePath, coreEvidencePath, finderScreenshot, receiverScreenshot]) {
  await access(output).then(
    () => { throw new Error(`物理验收输出已存在，拒绝覆盖：${output}`); },
    () => undefined,
  );
}

function appleScriptString(value: string): string {
  return `"${value.replace(/\\/gu, "\\\\").replace(/"/gu, "\\\"")}"`;
}

async function osascript(lines: string[]): Promise<string> {
  const args = lines.flatMap((line) => ["-e", line]);
  const result = await execFileAsync("/usr/bin/osascript", args, { encoding: "utf8" });
  return String(result.stdout).trim();
}

async function exists(filePath: string): Promise<boolean> {
  return access(filePath).then(() => true, () => false);
}

async function waitFor<T>(
  label: string,
  read: () => Promise<T | undefined>,
  timeoutMs = 90_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const result = await read();
      if (result !== undefined) return result;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 180));
  }
  throw new Error(`${label} 超时${lastError ? `：${lastError instanceof Error ? lastError.message : String(lastError)}` : ""}`);
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, "utf8")) as T;
}

async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const exited = await Promise.race([
    new Promise<boolean>((resolve) => child.once("exit", () => resolve(true))),
    new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); }),
  ]);
  if (timer) clearTimeout(timer);
  return exited || child.exitCode !== null || child.signalCode !== null;
}

type PhysicalSession = {
  state: string;
  runtimeRoot: string;
  runtimeOwnerId: string;
  applicationPid: number;
  window: {
    workArea: { x: number; y: number; width: number; height: number };
  };
  build: { buildId?: string; sourceDigest?: string; mcpToolCount?: number };
  media: Record<"image" | "video" | "audio", { sourceBasename: string; sha256: string }>;
  dragHandles: Array<{
    kind: "image" | "video" | "audio";
    mediaSha256: string;
    screenCenter?: { x: number; y: number };
  }>;
  canvasState?: { armedKinds?: string[]; nodeCount?: number; exportHandleCount?: number };
  persistenceState?: { allMediaRegistered?: boolean; allPinnedNodesPersisted?: boolean };
};

const originalFrontBundleId = await osascript([
  'tell application "System Events" to get bundle identifier of first application process whose frontmost is true',
]).catch(() => "");
const originalMouse = await execFileAsync(cliclickExecutable, ["p:."] , { encoding: "utf8" })
  .then((result) => String(result.stdout).trim())
  .catch(() => "");

const harnessOutput: string[] = [];
const receiverOutput: string[] = [];
let harness: ChildProcess | undefined;
let receiver: ChildProcess | undefined;
let finderWindowOpened = false;
let runtimeRoot: string | undefined;
let cleanupError: string | undefined;
let terminal: Record<string, unknown> = {};
let runError: unknown;

async function activateProcess(pid: number): Promise<void> {
  await osascript([
    'tell application "System Events"',
    `set frontmost of first application process whose unix id is ${pid} to true`,
    "end tell",
  ]);
  await new Promise((resolve) => setTimeout(resolve, 220));
}

async function closeFinderWindow(): Promise<void> {
  if (!finderWindowOpened) return;
  const target = appleScriptString(finderTarget);
  await osascript([
    `set targetAlias to POSIX file ${target} as alias`,
    'tell application "Finder"',
    "repeat with candidateWindow in every Finder window",
    "try",
    "if (target of candidateWindow as alias) is targetAlias then close candidateWindow",
    "end try",
    "end repeat",
    "end tell",
  ]).catch(() => undefined);
  finderWindowOpened = false;
}

async function currentSession(): Promise<PhysicalSession> {
  return readJson<PhysicalSession>(sessionPath);
}

async function armHandle(session: PhysicalSession, kind: "image" | "video" | "audio"): Promise<{ x: number; y: number }> {
  const handle = session.dragHandles.find((candidate) => candidate.kind === kind);
  if (!handle?.screenCenter) throw new Error(`没有 ${kind} 的物理拖拽坐标。`);
  await activateProcess(session.applicationPid);
  await execFileAsync(cliclickExecutable, [
    "-r",
    `c:${handle.screenCenter.x},${handle.screenCenter.y}`,
    "w:300",
  ]);
  await waitFor(`${kind} 拖拽 token 准备`, async () => {
    const latest = await currentSession();
    return latest.canvasState?.armedKinds?.includes(kind) ? latest : undefined;
  }, 8_000);
  return handle.screenCenter;
}

async function physicalDrag(
  session: PhysicalSession,
  kind: "image" | "video" | "audio",
  target: { x: number; y: number },
): Promise<void> {
  const source = await armHandle(session, kind);
  const first = {
    x: source.x + Math.sign(target.x - source.x || 1) * 18,
    y: source.y + Math.sign(target.y - source.y || 1) * 8,
  };
  const second = {
    x: Math.round(source.x + (target.x - source.x) * 0.48),
    y: Math.round(source.y + (target.y - source.y) * 0.48),
  };
  await execFileAsync(cliclickExecutable, [
    "-r",
    "-e", "2",
    `dd:${source.x},${source.y}`,
    "w:120",
    `dm:${first.x},${first.y}`,
    "w:120",
    `dm:${second.x},${second.y}`,
    "w:180",
    `dm:${target.x},${target.y}`,
    "w:700",
    `du:${target.x},${target.y}`,
  ]);
}

try {
  await execFileAsync("/usr/bin/swiftc", [receiverSource, "-o", receiverExecutable], {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  harness = spawn(tsxExecutable, ["scripts/ui-native-media-drag-physical-harness.ts", sessionPath], {
    cwd: workspace,
    env: {
      ...process.env,
      AI_CANVAS_PHYSICAL_APP_EXECUTABLE: packagedExecutable,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  harness.stdout?.on("data", (chunk: Buffer) => harnessOutput.push(chunk.toString("utf8")));
  harness.stderr?.on("data", (chunk: Buffer) => harnessOutput.push(chunk.toString("utf8")));

  const session = await waitFor("物理验收 harness ready", async () => {
    if (!await exists(sessionPath)) return undefined;
    const candidate = await currentSession();
    if (candidate.state === "failed") throw new Error(`harness failed：${harnessOutput.join("").slice(-4_000)}`);
    return candidate.state === "ready"
      && candidate.runtimeOwnerId === NATIVE_DRAG_RUNTIME_OWNER
      && candidate.dragHandles?.length === 3
      && candidate.persistenceState?.allMediaRegistered === true
      && candidate.persistenceState?.allPinnedNodesPersisted === true
      ? candidate
      : undefined;
  });
  runtimeRoot = session.runtimeRoot;
  const { workArea } = session.window;
  const rightX = workArea.x + 1_180;
  const rightEdge = workArea.x + workArea.width;
  const targetTop = workArea.y + 36;
  const targetBottom = workArea.y + Math.min(workArea.height - 24, 880);
  const finderDropPoint = {
    x: Math.round((rightX + rightEdge) / 2),
    y: Math.round(targetTop + (targetBottom - targetTop) * 0.72),
  };
  const finderTargetLiteral = appleScriptString(finderTarget);
  await osascript([
    `set targetAlias to POSIX file ${finderTargetLiteral} as alias`,
    'tell application "Finder"',
    "set testWindow to make new Finder window to targetAlias",
    `set bounds of testWindow to {${rightX}, ${targetTop}, ${rightEdge}, ${targetBottom}}`,
    "set current view of testWindow to icon view",
    "activate",
    "end tell",
  ]);
  finderWindowOpened = true;
  await new Promise((resolve) => setTimeout(resolve, 500));

  for (const kind of ["image", "video", "audio"] as const) {
    await physicalDrag(session, kind, finderDropPoint);
    const targetPath = path.join(finderTarget, session.media[kind].sourceBasename);
    await waitFor(`${kind} Finder 复制体`, async () => await exists(targetPath) ? targetPath : undefined, 10_000);
  }
  await execFileAsync("/usr/sbin/screencapture", [
    "-x",
    `-R${rightX},${targetTop},${rightEdge - rightX},${targetBottom - targetTop}`,
    finderScreenshot,
  ]);
  await closeFinderWindow();

  receiver = spawn(receiverExecutable, [receiverTarget, receiverReadyPath, receiverReceiptPath], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  receiver.stdout?.on("data", (chunk: Buffer) => receiverOutput.push(chunk.toString("utf8")));
  receiver.stderr?.on("data", (chunk: Buffer) => receiverOutput.push(chunk.toString("utf8")));
  const receiverReady = await waitFor("原生其他软件接收窗口", async () => (
    await exists(receiverReadyPath)
      ? readJson<{ dropTarget: { x: number; y: number }; windowFrame: Record<string, number> }>(receiverReadyPath)
      : undefined
  ), 20_000);
  await physicalDrag(session, "image", receiverReady.dropTarget);
  const receipt = await waitFor("其他软件物理接收回执", async () => (
    await exists(receiverReceiptPath)
      ? readJson<{ targetPath: string }>(receiverReceiptPath)
      : undefined
  ), 10_000);
  await access(receipt.targetPath);
  const receiverWidth = Math.round(receiverReady.windowFrame.width ?? 0);
  const receiverHeight = Math.round(receiverReady.windowFrame.height ?? 0);
  const receiverX = Math.round(receiverReady.windowFrame.x ?? 0);
  const receiverY = Math.round(receiverReady.dropTarget.y - receiverHeight / 2);
  await execFileAsync("/usr/sbin/screencapture", [
    "-x",
    `-R${receiverX},${receiverY},${receiverWidth},${receiverHeight}`,
    receiverScreenshot,
  ]);

  await execFileAsync(tsxExecutable, [
    "scripts/verify-native-media-drag-physical-result.ts",
    sessionPath,
    finderTarget,
    finderScreenshot,
    receiverScreenshot,
    "AI Canvas Native Drop Receiver",
    coreEvidencePath,
    receiverReceiptPath,
  ], { cwd: workspace, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
} catch (error) {
  runError = error;
} finally {
  await closeFinderWindow();
  if (receiver && receiver.exitCode === null && receiver.signalCode === null) receiver.kill("SIGTERM");
  let receiverExited = receiver ? await waitForExit(receiver, 5_000) : true;
  const forcedReceiverKill = Boolean(receiver && !receiverExited);
  if (receiver && !receiverExited) {
    receiver.kill("SIGKILL");
    receiverExited = await waitForExit(receiver, 5_000);
  }
  if (harness && harness.exitCode === null && harness.signalCode === null) harness.kill("SIGTERM");
  let harnessExited = harness ? await waitForExit(harness, 20_000) : true;
  const forcedHarnessKill = Boolean(harness && !harnessExited);
  if (harness && !harnessExited) {
    harness.kill("SIGKILL");
    harnessExited = await waitForExit(harness, 5_000);
  }
  if (originalMouse && /^-?\d+,-?\d+$/u.test(originalMouse)) {
    await execFileAsync(cliclickExecutable, [`m:${originalMouse}`]).catch(() => undefined);
  }
  if (originalFrontBundleId) {
    await osascript([`tell application id ${appleScriptString(originalFrontBundleId)} to activate`]).catch(() => undefined);
  }
  if (runtimeRoot && harnessExited && await exists(runtimeRoot)) {
    await removeOwnedTemporaryFixtureRoot(runtimeRoot, NATIVE_DRAG_RUNTIME_OWNER).catch((error) => {
      cleanupError = error instanceof Error ? error.message : String(error);
    });
  }
  const runtimeRootRemoved = runtimeRoot ? !await exists(runtimeRoot) : true;
  try {
    await rm(controlRoot, { recursive: true, force: true });
  } catch (error) {
    cleanupError = error instanceof Error ? error.message : String(error);
  }
  terminal = {
    harnessExited,
    receiverExited,
    forcedHarnessKill,
    forcedReceiverKill,
    runtimeRootRemoved,
    controlRootRemoved: !await exists(controlRoot),
    focusRestoredToBundleId: originalFrontBundleId || null,
    mouseRestored: Boolean(originalMouse),
  };
  if (forcedHarnessKill || forcedReceiverKill || !runtimeRootRemoved || cleanupError) {
    runError ??= new Error(`物理验收清理不完整：${JSON.stringify({ terminal, cleanupError })}`);
  }
}

const coreEvidence = await exists(coreEvidencePath)
  ? JSON.parse(await readFile(coreEvidencePath, "utf8")) as Record<string, unknown>
  : undefined;
const finalEvidence = {
  schemaVersion: 1,
  kind: "native-media-drag-physical-run",
  runId,
  status: runError ? "failed" : "passed",
  completedAt: new Date().toISOString(),
  packagedExecutable,
  build: coreEvidence?.build,
  coreEvidence: coreEvidence ? {
    path: path.relative(workspace, coreEvidencePath).split(path.sep).join("/"),
    sha256: createHash("sha256").update(await readFile(coreEvidencePath)).digest("hex"),
  } : null,
  screenshots: {
    finder: await exists(finderScreenshot) ? path.relative(workspace, finderScreenshot).split(path.sep).join("/") : null,
    receiver: await exists(receiverScreenshot) ? path.relative(workspace, receiverScreenshot).split(path.sep).join("/") : null,
  },
  terminal,
  error: runError instanceof Error ? runError.stack ?? runError.message : runError ? String(runError) : undefined,
  logs: {
    harnessTail: harnessOutput.join("").slice(-4_000),
    receiverTail: receiverOutput.join("").slice(-2_000),
  },
};
await writeFile(evidencePath, `${JSON.stringify(finalEvidence, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
process.stdout.write(`${JSON.stringify({
  status: finalEvidence.status,
  evidencePath,
  coreEvidencePath: coreEvidence ? coreEvidencePath : null,
  terminal,
}, null, 2)}\n`);
if (runError) throw runError;
