/**
 * P25 受管画布三皮肤截图探针：同一夹具同一布局，分别截 浅色（默认）/深色/米色 三张画布图。
 * 主题经 main 探针 AI_CANVAS_CANVAS_THEME_PROBE 在截图前写入并重载；全部隔离目录+隔离 userData；
 * 不写正式工程；截图落 docs/evidence（新文件，不覆盖历史）。
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const workspace = path.resolve(process.cwd());
const electron = path.join(workspace, "node_modules", ".bin", "electron");
const registryPath = path.join(os.tmpdir(), `p25-theme-registry-${process.pid}.json`);
process.env.AI_CANVAS_REGISTRY_PATH = registryPath;

const { registerProject, setActiveProjectRegistration } = await import("../src/core/sidecar.js");
const { saveStudioCanvasLayout } = await import("../src/core/studio-canvas-layout-store.js");
const { computeSourceDigest } = await import("../src/core/build-identity.js");
const { createStudioP24TraceFixture } = await import("../tests/helpers/studio-p24-trace-fixture.js");

const THEMES = ["light", "dark", "paper"] as const;
const evidenceJsonPath = path.resolve(process.argv[2] ?? path.join(workspace, "docs/evidence/p25-canvas-theme-screenshots-20260721.json"));
const screenshotPrefix = path.resolve(process.argv[3] ?? path.join(workspace, "docs/evidence/p25-canvas-theme"));

for (const output of [evidenceJsonPath, ...THEMES.map((theme) => `${screenshotPrefix}-${theme}-20260721.png`)]) {
  await readFile(output).then(
    () => { throw new Error(`主题证据已存在，拒绝覆盖：${output}`); },
    () => undefined,
  );
}

const fixture = await createStudioP24TraceFixture();
const pinnedNodeIds = [
  "asset:character-ahang",
  "asset:scene-stone-room",
  "asset:prop-complete-golden-mask",
  `script:${fixture.scriptDocumentId}`,
  `prompt:${fixture.promptDocumentId}`,
  `unit:${fixture.units.four.unit.id}`,
];
await saveStudioCanvasLayout(fixture.root, { patch: { pinnedNodeIds } });
await registerProject(fixture.p7.shell.project);
await setActiveProjectRegistration(fixture.root);

const screenshots: Record<string, { path: string; bytes: number; sha256: string }> = {};
try {
  for (const theme of THEMES) {
    const screenshotPath = `${screenshotPrefix}-${theme}-20260721.png`;
    const env = {
      ...process.env,
      AI_CANVAS_REGISTRY_PATH: registryPath,
      AI_CANVAS_SCREENSHOT: screenshotPath,
      AI_CANVAS_SCREENSHOT_DELAY_MS: "12000",
      AI_CANVAS_CANVAS_THEME_PROBE: theme,
      AI_CANVAS_WINDOW_WIDTH: "1560",
      AI_CANVAS_WINDOW_HEIGHT: "980",
    };
    await execFileAsync(electron, [".", `--user-data-dir=${path.join(os.tmpdir(), `p25-theme-userdata-${process.pid}-${theme}`)}`], {
      cwd: workspace,
      env,
      timeout: 150_000,
      maxBuffer: 4_000_000,
    });
    const bytes = await readFile(screenshotPath);
    screenshots[theme] = {
      path: screenshotPath,
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
    process.stdout.write(`[${theme}] 截图完成（${screenshots[theme].bytes} B）\n`);
  }
} finally {
  await fixture.cleanup();
}

const digest = await computeSourceDigest(workspace);
const evidence = {
  schemaVersion: 1,
  kind: path.basename(evidenceJsonPath).startsWith("p28-") ? "p28-canvas-theme-screenshots" : "p25-canvas-theme-screenshots",
  sourceDigest: digest.sourceDigest,
  sourceFiles: digest.sourceFiles,
  sourceBytes: digest.sourceBytes,
  createdAt: new Date().toISOString(),
  themes: THEMES,
  pinnedNodeIds,
  screenshots,
  ...(path.basename(evidenceJsonPath).startsWith("p28-") ? {
    supersedesEvidence: "P25 同名截图曾被后续任务覆写；本索引使用 P28 新文件名与现场 SHA，旧文件保持不动。",
  } : {}),
};
await writeFile(evidenceJsonPath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
process.stdout.write(`证据索引：${evidenceJsonPath}\n`);
