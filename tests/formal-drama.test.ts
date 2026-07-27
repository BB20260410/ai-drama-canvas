import { access, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  inspectFormalDramaSource,
  materializeFormalDramaProject,
  parseFormalDramaEpisodeMarkdown,
} from "../src/core/formal-drama.js";

const roots: string[] = [];

afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function temporaryRoot(): Promise<string> {
  const created = await mkdtemp(path.join(os.tmpdir(), "ai-canvas-formal-drama-"));
  const root = await realpath(created);
  roots.push(root);
  return root;
}

const EP01 = `# 封神篇 EP01《征兵》

> **规格**：竖屏 9:16 中国神话唯美真人电影质感 ｜ 约 1 分 15 秒（75 秒）｜ 每分镜严格 5–15 秒 ｜ 共 2 镜

## 冷开

**镜01 [8s]** 画面：缓推·大远景·仰拍：黎明桑里村。｜光线：晨灰。｜音效：鼓点。

**镜02 [10s]** 画面：固定·仰拍·旗自天垂落满幅。｜光线：冷金。｜音效：旗响。

---

## 分镜运镜参数总表

| 镜号 | 时长 | 景别 | 帧率 | 备注 |
|---|---|---|---|---|
| 01 | 8s | 大远景 | 24fps | 开场 |
| 02 | 10s | 全景 | 48 | 旗落 |
`;

const EP12 = `# 封神篇 EP12《太师回朝》

> **规格**：竖屏9:16 · 中国神话唯美真人电影质感短剧 · 3镜 · 单镜5–15秒（24 秒）

## 冷开·夜奔

**镜01 [8s]**
画面：固定镜头·近景·西城门夜哨。栓子按戈倚墙。｜光线：夜。

**镜03A [6s]**
画面：固定·全景·标题卡。尘烟落定。｜生成注记：冷金标题浮起。

## 第一幕·入城

**镜10A [10s]**
画面：中近景·钉住的目光（敬侧独立锚点）。栓子仰望双鞭。｜音效：呼吸声。

---

## 分镜运镜参数总表

| 镜 | 时长 | 景别 | 焦距 | 机位 | 运镜·速度 | 帧率 | 段落 |
|---|---|---|---|---|---|---|---|
| 01 | 8s | 中景 | 50mm | 固定 | 固定·常速 | 24帧 | 冷开 |
| 03A | 6s | 全景 | 35mm | 固定 | 固定 | 48帧 | 冷开 |
| 10A | 10s | 中近景 | 85mm | 平视 | 固定微推 | 60fps | 第一幕 |
`;

async function sourceFixture(parent: string): Promise<string> {
  const sourceRoot = path.join(parent, "剧本_封神篇");
  const references = path.join(sourceRoot, "封神篇内容", "refs");
  await mkdir(references, { recursive: true });
  await Promise.all([
    writeFile(path.join(sourceRoot, "封神篇_EP01_征兵.md"), EP01, "utf8"),
    writeFile(path.join(sourceRoot, "封神篇_EP12_太师回朝.md"), EP12, "utf8"),
    writeFile(path.join(references, "README_prompt_pack.md"), "# 参考板说明\n", "utf8"),
    writeFile(path.join(references, "ref_01.png"), Buffer.from("reference-png-fixture")),
    writeFile(path.join(sourceRoot, "原始包.zip"), Buffer.from("not-copied-but-inventoried")),
  ]);
  return sourceRoot;
}

describe("正式分镜剧本规范化", () => {
  it("解析常规同行正文、规格和参数表帧率", () => {
    const episode = parseFormalDramaEpisodeMarkdown(EP01, "/fixture/封神篇_EP01_征兵.md");

    expect(episode).toMatchObject({
      number: 1,
      episodeNumber: 1,
      episodeCode: "EP01",
      title: "征兵",
      totalDurationSeconds: 18,
      specification: {
        aspectRatio: "9:16",
        declaredShotCount: 2,
        declaredDurationSeconds: 75,
        shotDurationRangeSeconds: { minimum: 5, maximum: 15 },
      },
    });
    expect(episode.shots).toHaveLength(2);
    expect(episode.shots[0]).toMatchObject({
      number: "01",
      sourceCode: "01",
      sequence: 1,
      durationSeconds: 8,
      fps: 24,
      frameRate: 24,
      heading: "缓推·大远景·仰拍：黎明桑里村",
    });
    expect(episode.shots[1]?.fps).toBe(48);
    expect(episode.warnings).toEqual([]);
  });

  it("兼容 EP12 的换行正文、字母镜号和“24帧”格式", () => {
    const episode = parseFormalDramaEpisodeMarkdown(EP12, "/fixture/封神篇_EP12_太师回朝.md");

    expect(episode.shots.map((shot) => [shot.number, shot.sequence, shot.durationSeconds, shot.fps])).toEqual([
      ["01", 1, 8, 24],
      ["03A", 2, 6, 48],
      ["10A", 3, 10, 60],
    ]);
    expect(episode.shots[1]?.heading).toBe("固定·全景·标题卡");
    expect(episode.shots[2]?.body).toContain("敬侧独立锚点");
    expect(episode.warnings).toEqual([]);
  });

  it("只读建立完整文件清单，并把选定集落到可追溯隔离副本", async () => {
    const parent = await temporaryRoot();
    const sourceRoot = await sourceFixture(parent);
    const before = await inspectFormalDramaSource(sourceRoot);
    const repeated = await inspectFormalDramaSource(sourceRoot);

    expect(before).toMatchObject({ readOnly: true, sourceNativeMedia: false });
    expect(before.episodes.map((episode) => episode.number)).toEqual([1, 12]);
    expect(before.inventory.files).toHaveLength(5);
    expect(before.inventory.files.find((file) => file.relativePath === "原始包.zip")?.kind).toBe("other");
    expect(repeated.inventory.aggregateSha256).toBe(before.inventory.aggregateSha256);

    const targetRoot = path.join(parent, "正式分镜隔离副本");
    const result = await materializeFormalDramaProject({ sourceRoot, targetRoot, episodes: [12] });
    expect(result.episodes.map((episode) => episode.number)).toEqual([12]);
    expect(result.manifest).toMatchObject({
      selectedEpisodes: [12],
      sourceNativeMedia: false,
      derivedMedia: {
        rawImagesGenerated: false,
        labeledImagesGenerated: false,
        videosGenerated: false,
        audioGenerated: false,
      },
    });
    expect(result.manifest.units.map((unit) => [unit.sourceShotCode, unit.sequence])).toEqual([
      ["01", 1],
      ["03A", 2],
      ["10A", 3],
    ]);
    expect(result.manifest.snapshotFiles.map((file) => file.relativePath)).toEqual([
      "封神篇_EP01_征兵.md",
      "封神篇_EP12_太师回朝.md",
      "封神篇内容/refs/README_prompt_pack.md",
      "封神篇内容/refs/ref_01.png",
    ]);
    expect(result.manifest.snapshotFiles.some((file) => file.relativePath === "原始包.zip")).toBe(false);

    const aUnit = result.manifest.units.find((unit) => unit.sourceShotCode === "03A");
    expect(path.basename(aUnit?.directory ?? "")).toBe("EP12_15s_002_固定·全景·标题卡");
    expect(await readFile(aUnit?.infoPath ?? "", "utf8")).toContain("- 原始镜号：03A");
    expect(await readFile(aUnit?.infoPath ?? "", "utf8")).toContain("- 帧率：48fps");
    expect(JSON.parse(await readFile(path.join(targetRoot, "formal-source-manifest.json"), "utf8"))).toMatchObject({
      kind: "formal-drama-source-materialization",
      selectedEpisodes: [12],
    });
    await expect(access(path.join(targetRoot, "source_snapshot", "封神篇内容", "refs", "ref_01.png"))).resolves.toBeUndefined();

    const after = await inspectFormalDramaSource(sourceRoot);
    expect(after.inventory.aggregateSha256).toBe(before.inventory.aggregateSha256);
  });

  it("拒绝既存目标、源内目标以及任意源内符号链接", async () => {
    const parent = await temporaryRoot();
    const sourceRoot = await sourceFixture(parent);
    const existingTarget = path.join(parent, "已存在目标");
    await mkdir(existingTarget);

    await expect(materializeFormalDramaProject({ sourceRoot, targetRoot: existingTarget, episodes: [1] }))
      .rejects.toThrow("目标目录必须不存在");
    await expect(materializeFormalDramaProject({ sourceRoot, targetRoot: path.join(sourceRoot, "输出"), episodes: [1] }))
      .rejects.toThrow("不得等于或位于只读源根内");

    await symlink(path.join(sourceRoot, "封神篇_EP01_征兵.md"), path.join(sourceRoot, "剧本链接.md"));
    await expect(inspectFormalDramaSource(sourceRoot)).rejects.toThrow("禁止符号链接");
  });

  it("拒绝通过符号链接父目录绕入目标", async () => {
    const parent = await temporaryRoot();
    const sourceRoot = await sourceFixture(parent);
    const realTargetParent = path.join(parent, "真实目标父目录");
    const linkedTargetParent = path.join(parent, "目标父目录链接");
    await mkdir(realTargetParent);
    await symlink(realTargetParent, linkedTargetParent);

    await expect(materializeFormalDramaProject({
      sourceRoot,
      targetRoot: path.join(linkedTargetParent, "隔离副本"),
      episodes: [1],
    })).rejects.toThrow("目标目录父路径禁止符号链接");
    await expect(access(path.join(realTargetParent, "隔离副本"))).rejects.toThrow();
  });
});
