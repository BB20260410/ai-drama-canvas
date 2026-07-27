import { access, appendFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { SIDECAR_DIR } from "../../src/core/constants.js";
import {
  ensureConfinedDirectory,
  openExclusiveConfinedFile,
} from "../../src/core/confined-project-storage.js";
import { withProjectLock } from "../../src/core/locks.js";

const [
  mode,
  projectRoot,
  lockName,
  activePath = "",
  journalPath = "",
  startGatePath = "",
  timeoutText = "5000",
  staleText = "600",
  holdText = "250",
] = process.argv.slice(2);

if (!mode || !projectRoot || !lockName) {
  throw new Error("用法：lock-sigkill-worker <empty-owner|payload-owner|contender> <projectRoot> <lockName> [...参数]");
}

function holdProcessOpen(): Promise<never> {
  const keepAlive = setInterval(() => undefined, 1_000);
  return new Promise<never>(() => undefined).finally(() => clearInterval(keepAlive));
}

function eventLine(event: string): string {
  return `${JSON.stringify({ event, pid: process.pid, at: Date.now() })}\n`;
}

if (mode === "empty-owner") {
  const root = path.resolve(projectRoot);
  const directory = await ensureConfinedDirectory(root, path.join(root, SIDECAR_DIR, "locks"));
  const owned = await openExclusiveConfinedFile(directory, `${lockName}.lock`);
  process.stdout.write(eventLine("READY_EMPTY"));
  // 保持真实 fd 与进程存活，等待父测试在 payload 写入前发送 SIGKILL。
  await holdProcessOpen();
  await owned.handle.close();
} else if (mode === "payload-owner") {
  await withProjectLock(projectRoot, lockName, async () => {
    // 回调开始意味着 createOwnedLock 已完成 payload write + fsync。
    process.stdout.write(eventLine("READY_PAYLOAD"));
    await holdProcessOpen();
  });
} else if (mode === "contender") {
  if (!activePath || !journalPath || !startGatePath) {
    throw new Error("contender 缺少 activePath、journalPath 或 startGatePath。");
  }
  const timeoutMs = Number(timeoutText);
  const staleMs = Number(staleText);
  const holdMs = Number(holdText);
  if (![timeoutMs, staleMs, holdMs].every(Number.isFinite)) throw new Error("contender 数值参数无效。");

  process.stdout.write(eventLine("ARMED"));
  while (true) {
    try {
      await access(startGatePath);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  await withProjectLock(projectRoot, lockName, async () => {
    let ownsSentinel = false;
    try {
      await writeFile(activePath, `${process.pid}\n`, { encoding: "utf8", flag: "wx" });
      ownsSentinel = true;
      await appendFile(journalPath, eventLine("ENTER"), "utf8");
      await new Promise((resolve) => setTimeout(resolve, holdMs));
      await appendFile(journalPath, eventLine("LEAVE"), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        await appendFile(journalPath, eventLine("OVERLAP"), "utf8");
      }
      throw error;
    } finally {
      if (ownsSentinel) await rm(activePath, { force: true });
    }
  }, { timeoutMs, staleMs });
  process.stdout.write(eventLine("DONE"));
} else {
  throw new Error(`未知 worker 模式：${mode}`);
}
