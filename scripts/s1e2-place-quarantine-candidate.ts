import sharp from "sharp";
import { copyFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

async function main() {
  const src = process.argv[2];
  const out = process.argv[3];
  if (!src || !out) throw new Error("usage: src out");
  if (!existsSync(src)) throw new Error(`missing ${src}`);
  const m = await sharp(src).rotate().metadata();
  console.log("in", m.width, m.height, m.width && m.height ? m.width / m.height : null);
  let img = sharp(src).rotate();
  const w0 = m.width ?? 0;
  const h0 = m.height ?? 0;
  const ar = w0 / h0;
  if (h0 <= w0 || Math.abs(ar - 9 / 16) > 0.025) {
    const h = 1280;
    const w = Math.round((h * 9) / 16);
    img = img.resize(w, h, { fit: "cover", position: "centre" });
  }
  await img.png().toFile(out);
  const m2 = await sharp(out).metadata();
  const buf = readFileSync(out);
  const sha = createHash("sha256").update(buf).digest("hex");
  console.log("out", m2.width, m2.height, "sha", sha, "bytes", buf.length);
  // prove mtime is now
  const now = new Date();
  writeFileSync(out + ".meta.json", JSON.stringify({ placedAt: now.toISOString(), sha, width: m2.width, height: m2.height }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
