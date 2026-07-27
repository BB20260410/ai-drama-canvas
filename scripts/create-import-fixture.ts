import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { resetOwnedFixtureRoot } from "./lib/owned-fixture-root.js";

const root = path.resolve(process.argv[2] || path.join(os.tmpdir(), `ai-canvas-import-ui-fixture-${process.pid}-${randomUUID()}`));
const sourceRoot = `${root}-source`;
await Promise.all([
  resetOwnedFixtureRoot(root, "create-import-fixture-primary"),
  resetOwnedFixtureRoot(sourceRoot, "create-import-fixture-source"),
]);

async function createUnit(base: string, episode: number, unit: number, title: string, complete = false) {
  const stem = `EP${String(episode).padStart(2, "0")}_15s_${String(unit).padStart(3, "0")}`;
  const directory = path.join(base, `${stem}_${title}`);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "00_信息.md"), `# ${stem} ${title}\n\n首帧提示词：电影写实，${title}。\n尾帧提示词：延续动作与光线。\n`, "utf8");
  for (const variant of complete ? ["首帧", "尾帧"] : ["首帧"]) {
    await sharp({ create: { width: 720, height: 1280, channels: 3, background: variant === "首帧" ? "#76523d" : "#385f68" } }).png().toFile(path.join(directory, `${stem}_${variant}_raw.png`));
    if (complete) await sharp({ create: { width: 720, height: 1280, channels: 3, background: variant === "首帧" ? "#8b674e" : "#497a84" } }).png().toFile(path.join(directory, `${stem}_${variant}_labeled.png`));
  }
}

await createUnit(root, 1, 1, "雾河神落", true);
await createUnit(root, 1, 2, "祭坛醒转");
await createUnit(sourceRoot, 2, 1, "外部剧本来源");
await mkdir(path.join(root, "旧版", "EP01_15s_003_弃用样本"), { recursive: true });
await writeFile(path.join(root, "旧版", "EP01_15s_003_弃用样本", "00_信息.md"), "首帧提示词：旧版。\n", "utf8");
process.stdout.write(`${JSON.stringify({ root, sourceRoot })}\n`);
