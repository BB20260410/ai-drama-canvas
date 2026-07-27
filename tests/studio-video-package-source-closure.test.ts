import { createHash } from "node:crypto";
import {
  mkdtemp,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  bindStudioVideoPackageSourceClosure,
  freezeStudioVideoPackageSourceClosure,
  readStudioVideoPackageSourceClosure,
  readStudioVideoPackageSourceClosureBinding,
  verifyStudioVideoPackageSourceClosure,
} from "../src/core/studio-video-package-source-closure.js";

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

describe("studio video package source closure CAS", () => {
  const cleanupRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(cleanupRoots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true })));
  });

  it("keeps an intent-bound old closure readable after external replacement and creates a new closure", async () => {
    const projectRoot = await realpath(
      await mkdtemp(path.join(os.tmpdir(), "video-source-closure-project-")),
    );
    const externalRoot = await realpath(
      await mkdtemp(path.join(os.tmpdir(), "video-source-closure-external-")),
    );
    cleanupRoots.push(projectRoot, externalRoot);

    const sourceSpecPath = path.join(externalRoot, "U01_video.json");
    const rawPath = path.join(externalRoot, "U01_raw.png");
    const originalSpec = Buffer.from('{"schema_version":"2.0","unit_id":"U01"}\n', "utf8");
    const originalRaw = Buffer.from("raw-v1-content", "utf8");
    const builderBytes = Buffer.from("# deterministic builder v1\n", "utf8");
    await writeFile(sourceSpecPath, originalSpec, { flag: "wx" });
    await writeFile(rawPath, originalRaw, { flag: "wx" });

    const first = await freezeStudioVideoPackageSourceClosure(projectRoot, {
      metadata: {
        authorityKind: "studio-review",
        unitId: "U01",
        projectionMode: "studio-review-derived",
      },
      entries: [
        {
          role: "source-spec",
          logicalPath: "05_提示词/U01_video.json",
          sourcePath: sourceSpecPath,
          expectedSha256: sha256(originalSpec),
        },
        {
          role: "raw",
          logicalPath: "04_宫格成品/U01_raw.png",
          sourcePath: rawPath,
          expectedSha256: sha256(originalRaw),
        },
        {
          role: "builder",
          logicalPath: "tools/build_video_submission_pack.py",
          bytes: builderBytes,
          expectedSha256: sha256(builderBytes),
        },
      ],
    });
    const firstInputFingerprint = sha256(
      `studio-video-package-input:${first.closure.fingerprint}`,
    );
    const firstBinding = await bindStudioVideoPackageSourceClosure(
      projectRoot,
      firstInputFingerprint,
      first.closure.fingerprint,
    );
    expect(firstBinding.sourceClosureFingerprint).toBe(first.closure.fingerprint);

    const replacementSpec = Buffer.from(
      '{"schema_version":"2.0","unit_id":"U01","revision":2}\n',
      "utf8",
    );
    const replacementRaw = Buffer.from("raw-v2-content", "utf8");
    const replacementSpecPath = path.join(externalRoot, ".U01_video.replacement");
    const replacementRawPath = path.join(externalRoot, ".U01_raw.replacement");
    await writeFile(replacementSpecPath, replacementSpec, { flag: "wx" });
    await writeFile(replacementRawPath, replacementRaw, { flag: "wx" });
    await rename(replacementSpecPath, sourceSpecPath);
    await rename(replacementRawPath, rawPath);

    // build/replay 按 intent inputFingerprint 解析绑定，只读项目内旧 CAS，
    // 不再读取已被替换的外部命名路径。
    const rebound = await readStudioVideoPackageSourceClosureBinding(
      projectRoot,
      firstInputFingerprint,
    );
    expect(rebound?.sourceClosureFingerprint).toBe(first.closure.fingerprint);
    const oldClosure = await readStudioVideoPackageSourceClosure(
      projectRoot,
      rebound!.sourceClosureFingerprint,
    );
    expect(oldClosure.files.find((file) => file.role === "source-spec")?.bytes)
      .toEqual(originalSpec);
    expect(oldClosure.files.find((file) => file.role === "raw")?.bytes)
      .toEqual(originalRaw);
    expect(oldClosure.files.every((file) => file.absolutePath.startsWith(
      path.join(projectRoot, ".aicanvas", "studio-video-package-source-closure"),
    ))).toBe(true);

    const second = await freezeStudioVideoPackageSourceClosure(projectRoot, {
      metadata: {
        authorityKind: "studio-review",
        unitId: "U01",
        projectionMode: "studio-review-derived",
      },
      entries: [
        {
          role: "source-spec",
          logicalPath: "05_提示词/U01_video.json",
          sourcePath: sourceSpecPath,
          expectedSha256: sha256(replacementSpec),
        },
        {
          role: "raw",
          logicalPath: "04_宫格成品/U01_raw.png",
          sourcePath: rawPath,
          expectedSha256: sha256(replacementRaw),
        },
        {
          role: "builder",
          logicalPath: "tools/build_video_submission_pack.py",
          bytes: builderBytes,
          expectedSha256: sha256(builderBytes),
        },
      ],
    });
    expect(second.closure.fingerprint).not.toBe(first.closure.fingerprint);

    const secondInputFingerprint = sha256(
      `studio-video-package-input:${second.closure.fingerprint}`,
    );
    const secondBinding = await bindStudioVideoPackageSourceClosure(
      projectRoot,
      secondInputFingerprint,
      second.closure.fingerprint,
    );
    expect(secondBinding.sourceClosureFingerprint).toBe(second.closure.fingerprint);
    await expect(bindStudioVideoPackageSourceClosure(
      projectRoot,
      firstInputFingerprint,
      second.closure.fingerprint,
    )).rejects.toThrow();

    const replay = await freezeStudioVideoPackageSourceClosure(projectRoot, {
      metadata: {
        projectionMode: "studio-review-derived",
        unitId: "U01",
        authorityKind: "studio-review",
      },
      entries: [
        {
          role: "builder",
          logicalPath: "tools/build_video_submission_pack.py",
          bytes: builderBytes,
        },
        {
          role: "raw",
          logicalPath: "04_宫格成品/U01_raw.png",
          sourcePath: rawPath,
        },
        {
          role: "source-spec",
          logicalPath: "05_提示词/U01_video.json",
          sourcePath: sourceSpecPath,
        },
      ],
    });
    expect(replay.closure.fingerprint).toBe(second.closure.fingerprint);
    expect(replay.createdManifest).toBe(false);
  });

  it("reads only requested roles and stream-verifies size and SHA without retaining unrequested large objects", async () => {
    const projectRoot = await realpath(
      await mkdtemp(path.join(os.tmpdir(), "video-source-closure-lazy-")),
    );
    cleanupRoots.push(projectRoot);
    const builderBytes = Buffer.from("# small deterministic builder\n", "utf8");
    const largeRawBytes = Buffer.alloc(12 * 1024 * 1024, 0x5a);
    const frozen = await freezeStudioVideoPackageSourceClosure(projectRoot, {
      entries: [
        {
          role: "builder",
          logicalPath: "tools/build.py",
          bytes: builderBytes,
          expectedSha256: sha256(builderBytes),
        },
        {
          role: "raw",
          logicalPath: "storyboard/U01_raw.png",
          bytes: largeRawBytes,
          expectedSha256: sha256(largeRawBytes),
        },
      ],
    });
    const rawEntry = frozen.closure.entries.find((entry) => entry.role === "raw")!;
    const rawObjectPath = path.join(
      projectRoot,
      ".aicanvas",
      "studio-video-package-source-closure",
      "objects",
      "sha256",
      rawEntry.sha256.slice(0, 2),
      rawEntry.sha256,
    );
    const quarantinedRawPath = `${rawObjectPath}.quarantined`;
    await rename(rawObjectPath, quarantinedRawPath);

    const selected = await readStudioVideoPackageSourceClosure(
      projectRoot,
      frozen.closure.fingerprint,
      { roles: ["builder"] },
    );
    expect(selected.files).toHaveLength(1);
    expect(selected.files[0]).toMatchObject({
      role: "builder",
      sha256: sha256(builderBytes),
      sizeBytes: builderBytes.byteLength,
    });
    expect(selected.files[0]!.bytes).toEqual(builderBytes);
    await expect(verifyStudioVideoPackageSourceClosure(
      projectRoot,
      frozen.closure.fingerprint,
      { roles: ["builder"] },
    )).resolves.toMatchObject({
      files: [{ role: "builder", sha256: sha256(builderBytes) }],
    });
    await expect(readStudioVideoPackageSourceClosure(
      projectRoot,
      frozen.closure.fingerprint,
      { roles: ["raw"] },
    )).rejects.toThrow();
    await rename(quarantinedRawPath, rawObjectPath);

    const originalRawPath = `${rawObjectPath}.original`;
    const corruptRawPath = `${rawObjectPath}.corrupt`;
    await writeFile(corruptRawPath, Buffer.alloc(rawEntry.sizeBytes, 0x4b), { flag: "wx" });
    await rename(rawObjectPath, originalRawPath);
    await rename(corruptRawPath, rawObjectPath);
    await expect(readStudioVideoPackageSourceClosure(
      projectRoot,
      frozen.closure.fingerprint,
      { roles: ["raw"] },
    )).rejects.toThrow(/对象校验失败/u);
    await expect(verifyStudioVideoPackageSourceClosure(
      projectRoot,
      frozen.closure.fingerprint,
      { roles: ["raw"] },
    )).rejects.toThrow(/对象校验失败/u);
    await rename(rawObjectPath, corruptRawPath);
    await rename(originalRawPath, rawObjectPath);

    const shortRawPath = `${rawObjectPath}.short`;
    await writeFile(shortRawPath, Buffer.from("short", "utf8"), { flag: "wx" });
    await rename(rawObjectPath, originalRawPath);
    await rename(shortRawPath, rawObjectPath);
    await expect(verifyStudioVideoPackageSourceClosure(
      projectRoot,
      frozen.closure.fingerprint,
      { roles: ["raw"] },
    )).rejects.toThrow(/对象校验失败/u);
    await rename(rawObjectPath, shortRawPath);
    await rename(originalRawPath, rawObjectPath);
  });
});
