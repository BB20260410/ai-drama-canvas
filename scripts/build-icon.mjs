import { execFile } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { promisify } from "node:util";
import path from "node:path";
import sharp from "sharp";

const exec = promisify(execFile);
const root = path.resolve(import.meta.dirname, "..");
const source = path.join(root, "build", "icon.svg");
const iconset = path.join(root, "build", "icon.iconset");
const master = path.join(iconset, "icon_512x512@2x.png");

await rm(iconset, { recursive: true, force: true });
await mkdir(iconset, { recursive: true });
await sharp(source).png().toFile(master);

for (const [size, name] of [
  [16, "icon_16x16.png"], [32, "icon_16x16@2x.png"],
  [32, "icon_32x32.png"], [64, "icon_32x32@2x.png"],
  [128, "icon_128x128.png"], [256, "icon_128x128@2x.png"],
  [256, "icon_256x256.png"], [512, "icon_256x256@2x.png"],
  [512, "icon_512x512.png"],
]) {
  await exec("sips", ["-z", String(size), String(size), master, "--out", path.join(iconset, name)]);
}

await exec("iconutil", ["-c", "icns", iconset, "-o", path.join(root, "build", "icon.icns")]);
