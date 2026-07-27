import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { setActiveProjectRegistration } from "../src/core/sidecar.js";
import { resetOwnedFixtureRoot } from "./lib/owned-fixture-root.js";

const execFileAsync = promisify(execFile);
const defaultSuffix = `${process.pid}-${randomUUID()}`;
const root = path.resolve(process.argv[2] || path.join(os.tmpdir(), `ai-canvas-large-ui-smoke-400-${defaultSuffix}`));
const screenshotPath = path.resolve(process.argv[3] || path.join(os.tmpdir(), `ai-canvas-large-ui-smoke-400-${defaultSuffix}.png`));
const registryPath = path.resolve(process.argv[4] || path.join(os.tmpdir(), `ai-canvas-large-ui-smoke-registry-${defaultSuffix}.json`));
const tsx = path.join(process.cwd(), "node_modules", ".bin", "tsx");
const electron = path.join(process.cwd(), "node_modules", ".bin", "electron");
// 缩略图等 userData 写入必须隔离，不能污染真实应用配置目录（审核轻#2）。
const userDataDir = path.join(os.tmpdir(), `ai-canvas-large-ui-smoke-userdata-${Date.now()}`);

await Promise.all([
  rm(screenshotPath, { force: true }),
  rm(`${screenshotPath}.debug.json`, { force: true }),
  rm(registryPath, { force: true }),
  resetOwnedFixtureRoot(userDataDir, "large-canvas-ui-userdata"),
]);

const env = { ...process.env, AI_CANVAS_REGISTRY_PATH: registryPath };
const fixture = await execFileAsync(tsx, ["scripts/create-large-fixture.ts", "400", root, "--thumbnails"], { cwd: process.cwd(), env, maxBuffer: 2_000_000 });
const fixtureResult = JSON.parse(fixture.stdout) as { recognized: number; thumbnails: number; scanDurationMs: number };
if (fixtureResult.recognized !== 400 || fixtureResult.thumbnails !== 400) throw new Error(`400 单元夹具不完整：${fixture.stdout}`);

// 应用启动只恢复显式活动项目，不猜测登记表第一项；夹具必须显式激活，否则会落在首屏导致探针全空。
process.env.AI_CANVAS_REGISTRY_PATH = registryPath;
await setActiveProjectRegistration(root);

await execFileAsync(electron, [".", `--user-data-dir=${userDataDir}`], {
  cwd: process.cwd(),
  env: {
    ...env,
    AI_CANVAS_PROJECT_ROOT: root,
    AI_CANVAS_SCREENSHOT: screenshotPath,
    AI_CANVAS_SCREENSHOT_DELAY_MS: "45000",
    AI_CANVAS_PERF_PROBE: "1",
    AI_CANVAS_WINDOW_WIDTH: "1560",
    AI_CANVAS_WINDOW_HEIGHT: "980",
  },
  timeout: 120_000,
  maxBuffer: 2_000_000,
});

const debug = JSON.parse(await readFile(`${screenshotPath}.debug.json`, "utf8")) as {
  performanceProbe?: {
    ok?: boolean;
    error?: string;
    checks?: Record<string, boolean>;
    logicalProductionNodes?: number;
    productionNodesInDom?: number;
    images?: { total: number; decoded: number };
    frames?: { p95Ms: number; maxMs: number };
    interactions?: Record<string, number>;
    virtualization?: { focusedDomIds: string[]; targetNodeId: string };
  };
};
const probe = debug.performanceProbe;
if (!probe) throw new Error("Electron 没有写出 400 单元性能探针。 ");
const failedChecks = Object.entries(probe.checks ?? {}).filter(([, passed]) => !passed).map(([name]) => name);
if (!probe.ok || failedChecks.length) throw new Error(`400 单元交互门禁失败：${probe.error ?? (failedChecks.join("、") || "未知错误")}`);
if (probe.logicalProductionNodes !== 400) throw new Error(`逻辑节点数不是 400：${probe.logicalProductionNodes ?? 0}`);
if ((probe.productionNodesInDom ?? 400) > 20 || (probe.images?.total ?? 400) > 12) throw new Error("视口切换后 DOM/图片数量没有保持有界。 ");
if ((probe.images?.decoded ?? 0) !== (probe.images?.total ?? -1)) throw new Error("目标视口存在未解码缩略图。 ");

process.stdout.write(`${JSON.stringify({ root, screenshotPath, debugPath: `${screenshotPath}.debug.json`, fixture: fixtureResult, performanceProbe: probe }, null, 2)}\n`);
