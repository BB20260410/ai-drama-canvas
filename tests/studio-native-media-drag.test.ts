import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createManagedProject } from "../src/core/managed-project.js";
import { importStudioMedia } from "../src/core/material-studio.js";
import {
  prepareStudioNativeMediaDragCopy,
  sanitizeStudioNativeMediaDragBasename,
} from "../src/core/studio-native-media-drag.js";

let temporaryRoot = "";
let projectRoot = "";
let exportRoot = "";

function digest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function importFixture(
  name: string,
  bytes: Buffer,
): Promise<Awaited<ReturnType<typeof importStudioMedia>>> {
  const sourcePath = path.join(projectRoot, "fixtures", name);
  await mkdir(path.dirname(sourcePath), { recursive: true });
  await writeFile(sourcePath, bytes);
  return importStudioMedia(projectRoot, { sourcePath });
}

beforeEach(async () => {
  temporaryRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), "studio-native-drag-")));
  const shell = await createManagedProject({
    parentRoot: temporaryRoot,
    name: "原生媒体拖出测试",
    slug: "native-media-drag",
  });
  projectRoot = shell.paths.root;
  exportRoot = path.join(temporaryRoot, "drag-cache");
});

afterEach(async () => {
  await rm(temporaryRoot, { recursive: true, force: true });
});

describe("受管媒体原生拖出复制体", () => {
  it("图片、视频、音频均复制为带扩展名的独立临时文件，CAS 原件保持不变", async () => {
    const imageBytes = await sharp({
      create: {
        width: 24,
        height: 18,
        channels: 3,
        background: { r: 32, g: 96, b: 160 },
      },
    }).png().toBuffer();
    const fixtures = [
      {
        name: "人物权威图.png",
        bytes: imageBytes,
        kind: "image",
        extension: ".png",
      },
      {
        name: "镜头成片.mp4",
        bytes: Buffer.from("fixture-video"),
        kind: "video",
        extension: ".mp4",
      },
      {
        name: "旁白.wav",
        bytes: Buffer.from("fixture-audio"),
        kind: "audio",
        extension: ".wav",
      },
    ] as const;

    for (const fixture of fixtures) {
      const media = await importFixture(fixture.name, fixture.bytes);
      const sourceBefore = await stat(media.objectPath, { bigint: true });
      const prepared = await prepareStudioNativeMediaDragCopy({
        projectRoot,
        mediaSha256: media.sha256,
        exportRoot,
        suggestedName: `../不安全/导出 ${fixture.kind}`,
      });
      const [sourceAfter, copiedMetadata, copiedBytes] = await Promise.all([
        stat(media.objectPath, { bigint: true }),
        lstat(prepared.exportPath, { bigint: true }),
        readFile(prepared.exportPath),
      ]);

      expect(prepared).toMatchObject({
        kind: fixture.kind,
        mimeType: media.mimeType,
        sha256: media.sha256,
        sizeBytes: fixture.bytes.byteLength,
      });
      expect(prepared.fileName.endsWith(fixture.extension)).toBe(true);
      expect(prepared.fileName).not.toMatch(/[\\/]/u);
      expect(path.dirname(prepared.exportPath)).toBe(prepared.temporaryDirectory);
      expect(path.resolve(prepared.exportPath).startsWith(`${path.resolve(exportRoot)}${path.sep}`)).toBe(true);
      expect(copiedMetadata.isFile()).toBe(true);
      expect(copiedMetadata.isSymbolicLink()).toBe(false);
      expect(copiedMetadata.ino).not.toBe(sourceBefore.ino);
      expect(copiedBytes).toEqual(fixture.bytes);
      expect(digest(copiedBytes)).toBe(media.sha256);
      expect(sourceAfter).toMatchObject({
        dev: sourceBefore.dev,
        ino: sourceBefore.ino,
        size: sourceBefore.size,
        mtimeNs: sourceBefore.mtimeNs,
      });
      expect(await readFile(media.objectPath)).toEqual(fixture.bytes);
    }
  });

  it("清理文件名且拒绝不存在的 SHA，不留下伪造导出文件", async () => {
    expect(sanitizeStudioNativeMediaDragBasename(
      "../../角色 A:*?.png",
      "fallback",
    )).toBe("角色_A");

    await expect(prepareStudioNativeMediaDragCopy({
      projectRoot,
      mediaSha256: "0".repeat(64),
      exportRoot,
      suggestedName: "不存在",
    })).rejects.toThrow("媒体不存在");
  });
});
