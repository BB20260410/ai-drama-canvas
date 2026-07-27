import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  inspectLocalCreativeProject,
  type LocalCreativeProjectIngestInput,
  type LocalCreativeSourceLayerRole,
} from "../src/core/local-creative-project-ingest.js";

const roots: string[] = [];
const pngFixture = (label = "") => Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from(label),
]);
const jpegFixture = (label = "") => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from(label)]);
const mp4Fixture = (brand = "isom") => Buffer.from(`\u0000\u0000\u0000\u0018ftyp${brand}\u0000\u0000\u0000\u0000${brand}`, "binary");
const wavFixture = () => Buffer.from("RIFF\u0000\u0000\u0000\u0000WAVEfmt ", "binary");

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixtureRoot(name: string): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), `${name}-`)));
  roots.push(root);
  return root;
}

function inputFor(rootPath: string, role: LocalCreativeSourceLayerRole = "ACTIVE_PRODUCTION"): LocalCreativeProjectIngestInput {
  return {
    projectKey: "fixture-story",
    projectName: "盘点测试作品",
    projectType: "ai-drama",
    sourceLayers: [{ role, rootPath }],
  };
}

describe("本机创作项目只读盘点", () => {
  it("目录名锁定、final、已生成只形成候选或正式媒体，绝不直接批准", async () => {
    const root = await fixtureRoot("local-ingest-path-hints");
    await mkdir(path.join(root, "锁定"), { recursive: true });
    await mkdir(path.join(root, "final"), { recursive: true });
    await mkdir(path.join(root, "已生成"), { recursive: true });
    await writeFile(path.join(root, "锁定", "角色.png"), pngFixture("candidate"));
    await writeFile(path.join(root, "final", "场景.jpg"), jpegFixture("candidate"));
    await writeFile(path.join(root, "已生成", "S1E1-U01_raw.png"), pngFixture("formal"));

    const preview = await inspectLocalCreativeProject(inputFor(root));
    expect(preview.files).toHaveLength(3);
    expect(preview.files.map((file) => file.status)).not.toContain("APPROVED_LOCK");
    expect(preview.files.find((file) => file.relativePath === "锁定/角色.png")?.status).toBe("CANDIDATE_LOCK");
    expect(preview.files.find((file) => file.relativePath === "final/场景.jpg")?.status).toBe("CANDIDATE_LOCK");
    expect(preview.files.find((file) => file.relativePath === "已生成/S1E1-U01_raw.png")?.status).toBe("FORMAL_MEDIA");
  });

  it("拒绝/禁用路径与上下文优先屏蔽，不被同文件中的 approved 字样提升", async () => {
    const root = await fixtureRoot("local-ingest-rejected");
    await mkdir(path.join(root, "REJECTED"), { recursive: true });
    await writeFile(path.join(root, "REJECTED", "坏候选.png"), pngFixture("bad"));
    await writeFile(
      path.join(root, "资产表.md"),
      "坏候选.png\n状态: APPROVED_LOCK\n结论：未批准，禁止使用，属于废稿。\n",
    );

    const preview = await inspectLocalCreativeProject(inputFor(root, "PRIMARY_AUTHORITY"));
    expect(preview.files.find((file) => file.basename === "坏候选.png")?.status).toBe("REJECTED_OR_FORBIDDEN");
    expect(preview.lockCandidates.some((file) => file.relativePath.includes("坏候选.png"))).toBe(false);
  });

  it("旧候选拒绝段落不污染验收表中的当前 PASS raw", async () => {
    const root = await fixtureRoot("local-ingest-scoped-rejection");
    await mkdir(path.join(root, "03_单格raw", "W01"), { recursive: true });
    const currentPath = path.join(root, "03_单格raw", "W01", "W01_G02_raw.png");
    await writeFile(currentPath, pngFixture("current-pass"));
    await writeFile(
      path.join(root, "W01_原尺寸视觉验收.md"),
      [
        "| 格 | 文件 | 结论 | 说明 |",
        "|---|---|---|---|",
        "| G02 | `W01_G02_raw.png` | 通过（v2） | 当前正式画面通过。 |",
        "",
        "## 生成候选处置",
        "",
        "- G02 v1 已归入 `90_拒绝候选/W01_G02_v1_越界.png`，不得使用。",
      ].join("\n"),
    );

    const preview = await inspectLocalCreativeProject(inputFor(root, "PRIMARY_AUTHORITY"));
    expect(preview.files.find((file) => file.absolutePath === currentPath)?.status).toBe("FORMAL_MEDIA");
  });

  it("JSON 其他字段中的 forbidden 文本不跨字段拒绝目标 raw", async () => {
    const root = await fixtureRoot("local-ingest-json-scoped-rejection");
    await mkdir(path.join(root, "03_单格raw"), { recursive: true });
    const currentPath = path.join(root, "03_单格raw", "W01_G03_raw.png");
    await writeFile(currentPath, pngFixture("json-current"));
    await writeFile(
      path.join(root, "binding.json"),
      JSON.stringify({
        target_raw: currentPath,
        negative_prompt: "forbidden creature body",
      }, null, 2),
    );

    const preview = await inspectLocalCreativeProject(inputFor(root, "PRIMARY_AUTHORITY"));
    expect(preview.files.find((file) => file.absolutePath === currentPath)?.status).toBe("FORMAL_MEDIA");
  });

  it("只有显式锁定批准/QC证据才批准，并在实际 SHA 匹配时记录 exact-sha-copy", async () => {
    const root = await fixtureRoot("local-ingest-approved");
    const image = pngFixture("authoritative-character-image");
    const sha256 = createHash("sha256").update(image).digest("hex");
    await writeFile(path.join(root, "char-dudu.png"), image);
    await writeFile(
      path.join(root, "01_权威裁决表.md"),
      [
        "参考资产：char-dudu.png",
        "状态: APPROVED_LOCK",
        "用途：唯一权威角色锁，用户确认。",
        "Review / QC: PASS",
        `SHA-256: ${sha256}`,
      ].join("\n"),
    );

    const preview = await inspectLocalCreativeProject({ ...inputFor(root, "PRIMARY_AUTHORITY"), computeSha256: true });
    const locked = preview.files.find((file) => file.basename === "char-dudu.png");
    expect(locked).toMatchObject({ status: "APPROVED_LOCK", sha256, sha256Source: "computed" });
    expect(locked?.evidence.map((entry) => entry.level)).toEqual(expect.arrayContaining([
      "declared-mention",
      "explicit-reference",
      "review-qc",
      "exact-sha-copy",
    ]));
    const reverse = preview.lockReferenceIndex.find((entry) => entry.lockFileId === locked?.fileId);
    expect(reverse?.referencedBy).toEqual([
      expect.objectContaining({
        path: path.join(root, "01_权威裁决表.md"),
        evidenceLevels: expect.arrayContaining(["review-qc", "exact-sha-copy"]),
      }),
    ]);
  });

  it("保留同一作品的多来源层，不把不同根中的同名文件静默合并", async () => {
    const root = await fixtureRoot("local-ingest-layers");
    const authority = path.join(root, "authority");
    const legacy = path.join(root, "legacy");
    await mkdir(authority);
    await mkdir(legacy);
    await writeFile(path.join(authority, "角色.png"), pngFixture("current"));
    await writeFile(path.join(legacy, "角色.png"), pngFixture("old"));
    await writeFile(path.join(authority, "资产.md"), "参考：角色.png\n状态: APPROVED_LOCK\n唯一权威角色锁\n");

    const preview = await inspectLocalCreativeProject({
      projectKey: "same-story",
      projectName: "同一作品",
      projectType: "ai-drama",
      sourceLayers: [
        { role: "LEGACY_HISTORY", rootPath: legacy },
        { role: "PRIMARY_AUTHORITY", rootPath: authority },
      ],
    });
    expect(preview.sourceLayers).toHaveLength(2);
    expect(preview.files.filter((file) => file.basename === "角色.png")).toHaveLength(2);
    expect(preview.files.find((file) => file.absolutePath === path.join(authority, "角色.png"))?.status).toBe("APPROVED_LOCK");
    expect(preview.files.find((file) => file.absolutePath === path.join(legacy, "角色.png"))?.status).toBe("UNKNOWN");
    expect(preview.statistics.bySourceLayerRole.PRIMARY_AUTHORITY).toBe(2);
    expect(preview.statistics.bySourceLayerRole.LEGACY_HISTORY).toBe(1);
  });

  it("不跟随内部符号链接，并拒绝把符号链接本身作为 source layer 根", async () => {
    const root = await fixtureRoot("local-ingest-symlink");
    const outside = path.join(root, "outside");
    const source = path.join(root, "source");
    await mkdir(outside);
    await mkdir(source);
    await writeFile(path.join(outside, "outside.png"), "must-not-follow");
    await symlink(outside, path.join(source, "linked-dir"));
    await symlink(path.join(outside, "outside.png"), path.join(source, "linked.png"));

    const preview = await inspectLocalCreativeProject(inputFor(source));
    expect(preview.files).toHaveLength(0);
    expect(preview.statistics.skippedSymlinks).toBe(2);
    expect(preview.warnings.filter((warning) => warning.code === "SYMLINK_SKIPPED")).toHaveLength(2);

    const linkedRoot = path.join(root, "linked-root");
    await symlink(source, linkedRoot);
    await expect(inspectLocalCreativeProject(inputFor(linkedRoot))).rejects.toThrow("根目录不能是符号链接");
  });

  it("相同文件树的 previewFingerprint 确定，scannedAt 不参与指纹", async () => {
    const root = await fixtureRoot("local-ingest-fingerprint");
    await writeFile(path.join(root, "剧本.md"), "第一场\n");
    await writeFile(path.join(root, "S1E1-U01_raw.png"), pngFixture("image"));
    const first = await inspectLocalCreativeProject(inputFor(root));
    const second = await inspectLocalCreativeProject(inputFor(root));
    expect(first.previewFingerprint).toBe(second.previewFingerprint);
    expect(first.previewFingerprint).toMatch(/^local-creative-[a-f0-9]{64}$/u);
  });

  it("文件晚于最新状态/索引证据时报告 stale-ledger 漂移", async () => {
    const root = await fixtureRoot("local-ingest-stale-ledger");
    const ledgerPath = path.join(root, "STATUS.md");
    const imagePath = path.join(root, "S1E1-U02_raw.png");
    await writeFile(ledgerPath, "S1E1-U02_raw.png：PENDING\n");
    await writeFile(imagePath, "new output");
    await utimes(ledgerPath, new Date("2026-01-01T00:00:00.000Z"), new Date("2026-01-01T00:00:00.000Z"));
    await utimes(imagePath, new Date("2026-01-02T00:00:00.000Z"), new Date("2026-01-02T00:00:00.000Z"));

    const preview = await inspectLocalCreativeProject(inputFor(root));
    expect(preview.warnings).toContainEqual(expect.objectContaining({
      code: "STALE_LEDGER",
      path: imagePath,
      ledgerPath,
    }));
  });

  it("排除 .git/.aicanvas/node_modules/cache/tmp 且不把其中内容计数", async () => {
    const root = await fixtureRoot("local-ingest-ignore");
    for (const name of [".git", ".aicanvas", "node_modules", "cache", "tmp"]) {
      await mkdir(path.join(root, name));
      await writeFile(path.join(root, name, `${name.replace(".", "") || "hidden"}.png`), "ignored");
    }
    await writeFile(path.join(root, "kept.pdf"), "%PDF fixture");
    await writeFile(path.join(root, "kept.docx"), "docx fixture");
    await writeFile(path.join(root, "kept.mp4"), mp4Fixture());
    await writeFile(path.join(root, "kept.wav"), wavFixture());

    const preview = await inspectLocalCreativeProject(inputFor(root));
    expect(preview.files.map((file) => file.basename).sort()).toEqual(["kept.docx", "kept.mp4", "kept.pdf", "kept.wav"]);
    expect(preview.statistics.byMediaKind).toMatchObject({ document: 2, video: 1, audio: 1, image: 0 });
  });

  it("支持限制扫描深度并排除已单独建项的嵌套来源前缀", async () => {
    const root = await fixtureRoot("local-ingest-bounded-source");
    await writeFile(path.join(root, "loose.png"), pngFixture("loose"));
    await mkdir(path.join(root, "nested", "deep"), { recursive: true });
    await writeFile(path.join(root, "nested", "hidden.png"), pngFixture("hidden-by-depth"));
    await writeFile(path.join(root, "nested", "deep", "hidden-too.png"), pngFixture("hidden-by-depth"));

    const shallow = await inspectLocalCreativeProject({
      ...inputFor(root, "UNASSIGNED_INBOX"),
      sourceLayers: [{ role: "UNASSIGNED_INBOX", rootPath: root, maxDepth: 1 }],
    });
    expect(shallow.files.map((file) => file.relativePath)).toEqual(["loose.png"]);

    const authority = path.join(root, "authority");
    await mkdir(path.join(authority, "nested-project"), { recursive: true });
    await mkdir(path.join(authority, "kept"), { recursive: true });
    await writeFile(path.join(authority, "nested-project", "must-not-duplicate.png"), pngFixture("nested-project"));
    await writeFile(path.join(authority, "kept", "story.md"), "kept");
    const excluded = await inspectLocalCreativeProject({
      ...inputFor(authority, "PRIMARY_AUTHORITY"),
      sourceLayers: [{
        role: "PRIMARY_AUTHORITY",
        rootPath: authority,
        excludeRelativePrefixes: ["nested-project"],
      }],
    });
    expect(excluded.files.map((file) => file.relativePath)).toEqual(["kept/story.md"]);
  });

  it("拒绝越界或无效的来源扫描约束", async () => {
    const root = await fixtureRoot("local-ingest-invalid-bounds");
    await expect(inspectLocalCreativeProject({
      ...inputFor(root),
      sourceLayers: [{ role: "ACTIVE_PRODUCTION", rootPath: root, maxDepth: 0 }],
    })).rejects.toThrow("maxDepth");
    await expect(inspectLocalCreativeProject({
      ...inputFor(root),
      sourceLayers: [{ role: "ACTIVE_PRODUCTION", rootPath: root, excludeRelativePrefixes: ["../escape"] }],
    })).rejects.toThrow("excludeRelativePrefixes");
  });

  it("通过文件签名纳入无扩展名图像、视频和音频，未知二进制仍忽略", async () => {
    const root = await fixtureRoot("local-ingest-extensionless");
    await writeFile(path.join(root, "image"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]));
    await writeFile(path.join(root, "video"), Buffer.from("....ftypmp42........", "ascii"));
    await writeFile(path.join(root, "audio"), Buffer.from("ID3audio", "ascii"));
    await writeFile(path.join(root, "unknown"), Buffer.from("not-media", "ascii"));

    const preview = await inspectLocalCreativeProject(inputFor(root));
    expect(preview.files.map((file) => [file.basename, file.mediaKind])).toEqual([
      ["audio", "audio"],
      ["image", "image"],
      ["video", "video"],
    ]);
  });

  it("所有媒体扩展都核验签名：PNG 名 MP4 采用真实类型并告警，XML/未知伪 PNG 被拒绝，正常 PNG 不回归", async () => {
    const root = await fixtureRoot("local-ingest-media-signatures");
    await writeFile(path.join(root, "wrong.png"), mp4Fixture());
    await writeFile(path.join(root, "placeholder.png"), '<?xml version="1.0"?><Error>not an image</Error>');
    await writeFile(path.join(root, "unknown.png"), "not-media");
    await writeFile(path.join(root, "normal.png"), pngFixture("normal"));

    const preview = await inspectLocalCreativeProject(inputFor(root));
    expect(preview.files.find((file) => file.basename === "wrong.png")).toMatchObject({
      mediaKind: "video",
      status: "FORMAL_MEDIA",
    });
    expect(preview.warnings).toContainEqual(expect.objectContaining({
      code: "MEDIA_SIGNATURE_EXTENSION_MISMATCH",
      path: path.join(root, "wrong.png"),
      extensionKind: "image",
      detectedKind: "video",
      detectedSignature: "isobmff-video",
    }));
    for (const basename of ["placeholder.png", "unknown.png"]) {
      expect(preview.files.find((file) => file.basename === basename)).toMatchObject({
        mediaKind: "image",
        status: "REJECTED_OR_FORBIDDEN",
      });
      expect(preview.warnings).toContainEqual(expect.objectContaining({
        code: "MEDIA_SIGNATURE_INVALID",
        path: path.join(root, basename),
      }));
    }
    expect(preview.files.find((file) => file.basename === "normal.png")).toMatchObject({
      mediaKind: "image",
      status: "FORMAL_MEDIA",
    });
    expect(preview.warnings.some((warning) => warning.path === path.join(root, "normal.png")
      && (warning.code === "MEDIA_SIGNATURE_INVALID" || warning.code === "MEDIA_SIGNATURE_EXTENSION_MISMATCH"))).toBe(false);
  });
});
