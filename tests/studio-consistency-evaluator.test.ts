import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { access, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp, { type PngOptions } from "sharp";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  evaluateStudioConsistency,
  resetStudioConsistencyEvaluatorForTests,
  type ConsistencyEvaluationRequest,
  type ConsistencyEvaluationReference,
} from "../src/core/studio-consistency-evaluator.js";

/**
 * P19 判定器定向测试（规范 .planning/P19_差距审计与实施规范.md v2.1 §7）。
 * 夹具：sharp 合成（真实解码管线、确定可重现）+ 可选真实本地图冒烟组（存在守卫）。
 */

const temporaryRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "p19-consistency-"));
  temporaryRoots.push(root);
  return root;
}

afterAll(async () => {
  await Promise.all(temporaryRoots.map((root) => rm(root, { recursive: true, force: true })));
});

beforeEach(() => {
  resetStudioConsistencyEvaluatorForTests();
});

const BASE_SVG = `<svg width="256" height="256" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#3a6ea5"/><stop offset="1" stop-color="#152027"/></linearGradient></defs><rect width="256" height="256" fill="url(#g)"/><circle cx="150" cy="96" r="52" fill="#d7af55" opacity="0.85"/><rect x="40" y="160" width="120" height="60" fill="#e8e4d8" opacity="0.7"/><path d="M0 220 Q60 180 130 215 T256 205 V256 H0Z" fill="#101613" opacity="0.6"/></svg>`;
const UNRELATED_SVG = `<svg width="256" height="256" xmlns="http://www.w3.org/2000/svg"><rect width="256" height="256" fill="#7a2030"/><rect x="30" y="30" width="60" height="196" fill="#204020"/><circle cx="200" cy="200" r="34" fill="#203090"/><path d="M20 128 L236 128" stroke="#f0f0f0" stroke-width="9"/><path d="M128 20 L128 236" stroke="#f0f0f0" stroke-width="9"/></svg>`;

async function writeBase(filePath: string, options: { brightness?: number; hue?: number; shiftX?: number } = {}): Promise<void> {
  let image = sharp(Buffer.from(BASE_SVG));
  if (options.brightness || options.hue) image = image.modulate({ ...(options.brightness ? { brightness: options.brightness } : {}), ...(options.hue ? { hue: options.hue } : {}) });
  let buffer = await image.png().toBuffer();
  if (options.shiftX) {
    buffer = await sharp({ create: { width: 256, height: 256, channels: 3, background: "#152027" } })
      .composite([{ input: buffer, left: options.shiftX, top: 0 }])
      .png()
      .toBuffer();
  }
  await writeFile(filePath, buffer);
}

function sha(fileBuffer: Buffer): string {
  return createHash("sha256").update(fileBuffer).digest("hex");
}

async function fileSha(filePath: string): Promise<string> {
  return sha(await readFile(filePath));
}

function currentFileSha(filePath: string, fallback: string): string {
  try {
    return existsSync(filePath) && lstatSync(filePath).isFile() && !lstatSync(filePath).isSymbolicLink()
      ? sha(readFileSync(filePath))
      : fallback;
  } catch {
    return fallback;
  }
}

function makeRequest(root: string, overrides: Partial<ConsistencyEvaluationRequest> & { references: ConsistencyEvaluationReference[] }): ConsistencyEvaluationRequest {
  const request: ConsistencyEvaluationRequest = {
    projectRoot: root,
    projectId: "project-p19-test",
    generationRunId: "run-p19-test-1",
    packFingerprint: "f".repeat(64),
    result: { sha256: "a".repeat(64), objectPath: path.join(root, "result.png") },
    ...overrides,
  };
  return {
    ...request,
    result: {
      ...request.result,
      sha256: currentFileSha(request.result.objectPath, request.result.sha256),
    },
    references: request.references.map((reference) => ({
      ...reference,
      mediaSha256: currentFileSha(reference.objectPath, reference.mediaSha256),
    })),
  };
}

function makeReference(root: string, options: Partial<ConsistencyEvaluationReference> & { objectPath: string }): ConsistencyEvaluationReference {
  return {
    assetId: options.assetId ?? "asset-1",
    category: options.category ?? "character",
    assetVersionId: options.assetVersionId ?? "version-1",
    mediaSha256: currentFileSha(options.objectPath, options.mediaSha256 ?? "b".repeat(64)),
    objectPath: options.objectPath,
    ...(options.isAnimal !== undefined ? { isAnimal: options.isAnimal } : {}),
    ...(options.currentPrimaryAuthorityVersionId ? { currentPrimaryAuthorityVersionId: options.currentPrimaryAuthorityVersionId } : {}),
    ...(options.structuralChecklist ? { structuralChecklist: options.structuralChecklist } : {}),
  };
}

async function writePair(root: string, lightOptions: Parameters<typeof writeBase>[1] = { brightness: 1.08, hue: 6 }): Promise<{ resultPath: string; samePath: string; lightPath: string; unrelatedPath: string }> {
  const resultPath = path.join(root, "result.png");
  const samePath = path.join(root, "same.png");
  const lightPath = path.join(root, "light.png");
  const unrelatedPath = path.join(root, "unrelated.png");
  await writeBase(resultPath);
  await writeBase(samePath);
  await writeBase(lightPath, lightOptions);
  await sharp(Buffer.from(UNRELATED_SVG)).png().toFile(unrelatedPath);
  return { resultPath, samePath, lightPath, unrelatedPath };
}

const CATEGORIES = [
  { name: "character（人物）", category: "character" as const, isAnimal: undefined },
  { name: "character（动物映射）", category: "character" as const, isAnimal: true },
  { name: "scene（场景）", category: "scene" as const, isAnimal: undefined },
  { name: "prop（道具）", category: "prop" as const, isAnimal: undefined },
];

describe("P19 §7-1 四类资产 × 三种关系排序（综合加权距离严格递增）", () => {
  for (const entry of CATEGORIES) {
    it(`${entry.name}：同图 < 轻微变化 < 无关图`, async () => {
      const root = await makeTempRoot();
      const pair = await writePair(root);
      const distances: number[] = [];
      const verdicts: string[] = [];
      for (const candidate of [pair.samePath, pair.lightPath, pair.unrelatedPath]) {
        const result = await evaluateStudioConsistency(makeRequest(root, {
          result: { sha256: await fileSha(pair.resultPath), objectPath: pair.resultPath },
          references: [makeReference(root, { objectPath: candidate, category: entry.category, ...(entry.isAnimal !== undefined ? { isAnimal: entry.isAnimal } : {}) })],
        }));
        const compositeDistance = result.assets[0]?.compositeDistance;
        expect(compositeDistance, `${entry.name} ${candidate} 应暴露综合加权距离`).toBeTypeOf("number");
        distances.push(compositeDistance!);
        verdicts.push(result.assets[0]!.verdict);
        if (entry.isAnimal) expect(result.assets[0]?.isAnimal).toBe(true);
      }
      expect(distances[0]!).toBeLessThan(distances[1]!);
      expect(distances[1]!).toBeLessThan(distances[2]!);
      expect(verdicts[0]).toBe("consistent");
      expect(verdicts[2]).toBe("drifted");
      expect(["consistent", "needs-review"]).toContain(verdicts[1]);
    });
  }

  it("动物资产与人物资产走同一 character 权重路径（同输入同判定）", async () => {
    const root = await makeTempRoot();
    const pair = await writePair(root);
    const base = { result: { sha256: await fileSha(pair.resultPath), objectPath: pair.resultPath } };
    const human = await evaluateStudioConsistency(makeRequest(root, { ...base, references: [makeReference(root, { objectPath: pair.lightPath, category: "character" })] }));
    const animal = await evaluateStudioConsistency(makeRequest(root, { ...base, references: [makeReference(root, { objectPath: pair.lightPath, category: "character", isAnimal: true, assetId: "asset-animal" })] }));
    expect(animal.assets[0]?.verdict).toBe(human.assets[0]?.verdict);
    expect(animal.assets[0]?.compositeDistance).toBe(human.assets[0]?.compositeDistance);
    expect(animal.assets[0]?.isAnimal).toBe(true);
  });

  it("盲审 R2-F1：部分资产无法检查时总体封顶 needs-review，不报一致", async () => {
    const root = await makeTempRoot();
    const pair = await writePair(root);
    const corruptPath = path.join(root, "corrupt.png");
    await writeFile(corruptPath, "not an image", "utf8");
    const result = await evaluateStudioConsistency(makeRequest(root, {
      references: [
        makeReference(root, { objectPath: pair.samePath, assetId: "asset-good", mediaSha256: "1".repeat(64) }),
        makeReference(root, { objectPath: corruptPath, assetId: "asset-bad", mediaSha256: "2".repeat(64) }),
      ],
    }));
    expect(result.assets[0]?.verdict).toBe("consistent");
    expect(result.assets[1]?.verdict).toBe("not-checkable");
    expect(result.verdict).toBe("needs-review");
  });

  it("盲审 R2-F6：LRU 超 64 键逐出最旧键（重算），新键仍命中", async () => {
    const root = await makeTempRoot();
    const tiny = path.join(root, "tiny.png");
    await sharp({ create: { width: 64, height: 64, channels: 3, background: "#314653" } }).png().toFile(tiny);
    const makeKey = (index: number) => makeRequest(root, {
      generationRunId: `run-lru-${index}`,
      result: { sha256: sha(Buffer.from(`lru-${index}`)), objectPath: tiny },
      references: [makeReference(root, { objectPath: tiny, assetId: `asset-${index}`, mediaSha256: sha(Buffer.from(`m-${index}`)) })],
    });
    const first = await evaluateStudioConsistency(makeKey(1));
    for (let index = 2; index <= 66; index += 1) await evaluateStudioConsistency(makeKey(index));
    const second = await evaluateStudioConsistency(makeKey(2));
    expect(second.computedAt).toBe((await evaluateStudioConsistency(makeKey(2))).computedAt);
    void first;
    const recomputed = await evaluateStudioConsistency({ ...makeKey(1), now: () => "2026-07-21T00:00:00.000Z" });
    expect(recomputed.computedAt).toBe("2026-07-21T00:00:00.000Z");
  });

  it("排队中的请求响应 AbortSignal 即出队取消", async () => {
    const root = await makeTempRoot();
    const pair = await writePair(root);
    const heavyPath = path.join(root, "heavy.png");
    await sharp(pair.resultPath).resize(2048, 2048).png().toFile(heavyPath);
    const makeSlow = (suffix: string) => makeRequest(root, {
      generationRunId: `run-slow-${suffix}`,
      result: { sha256: sha(Buffer.from(suffix)), objectPath: heavyPath },
      references: [makeReference(root, { objectPath: heavyPath, assetId: `asset-${suffix}`, mediaSha256: sha(Buffer.from(`sm-${suffix}`)) })],
    });
    const occupy1 = evaluateStudioConsistency(makeSlow("a"));
    const occupy2 = evaluateStudioConsistency(makeSlow("b"));
    const controller = new AbortController();
    const queued = evaluateStudioConsistency({ ...makeSlow("c"), signal: controller.signal });
    controller.abort();
    const cancelled = await queued;
    expect(cancelled.verdict).toBe("not-checkable");
    expect(cancelled.transient).toBe(true);
    expect(cancelled.assets[0]?.criteria[0]?.note).toContain("评估已取消");
    await Promise.all([occupy1, occupy2]);
  });
});

describe("P19 §7-2 无法检查单列组（fail-closed）", () => {
  it("损坏图、缺失图、超小图、超限图、跨工程引用全部无法检查", async () => {
    const root = await makeTempRoot();
    const pair = await writePair(root);

    const corruptPath = path.join(root, "corrupt.png");
    await writeFile(corruptPath, "not an image", "utf8");
    const missingPath = path.join(root, "missing.png");
    const smallPath = path.join(root, "small.png");
    await sharp({ create: { width: 16, height: 16, channels: 3, background: "#314653" } }).png().toFile(smallPath);
    const outsideRoot = await makeTempRoot();
    const outsidePath = path.join(outsideRoot, "outside-p19.png");
    await sharp(Buffer.from(BASE_SVG)).png().toFile(outsidePath);

    for (const [label, candidate] of [["损坏图", corruptPath], ["缺失图", missingPath], ["超小图", smallPath], ["跨工程引用", outsidePath]] as const) {
      const result = await evaluateStudioConsistency(makeRequest(root, {
        references: [makeReference(root, { objectPath: candidate })],
      }));
      expect(result.verdict, label).toBe("not-checkable");
      expect(result.assets[0]?.verdict).toBe("not-checkable");
    }
    const crossProject = await evaluateStudioConsistency(makeRequest(root, {
      references: [makeReference(root, { objectPath: outsidePath })],
    }));
    expect(crossProject.evidence.errorClass).toBe("cross-project-reference");

    const hugePath = path.join(root, "huge.png");
    await sharp({ create: { width: 4200, height: 4200, channels: 3, background: "#314653" } }).png().toFile(hugePath);
    const huge = await evaluateStudioConsistency(makeRequest(root, {
      references: [makeReference(root, { objectPath: hugePath })],
    }));
    expect(huge.verdict).toBe("not-checkable");
    expect(huge.assets[0]?.criteria[0]?.note).toContain("参考图不可检查");
  });

  it("结果图自身不可解码 → 全体无法检查并计入异常分类", async () => {
    const root = await makeTempRoot();
    const pair = await writePair(root);
    const result = await evaluateStudioConsistency(makeRequest(root, {
      result: { sha256: "c".repeat(64), objectPath: path.join(root, "missing-result.png") },
      references: [makeReference(root, { objectPath: pair.samePath })],
    }));
    expect(result.verdict).toBe("not-checkable");
    expect(result.evidence.errorClass).toBeTruthy();
  });
});

describe("P19 §7-3 归一化（EXIF/CMYK/灰度/16bit/alpha 归一后同图关系成立）", () => {
  it("EXIF 旋转标记归一后与未旋转参考一致", async () => {
    const root = await makeTempRoot();
    const pair = await writePair(root);
    const rotatedPath = path.join(root, "rotated.jpg");
    await sharp(pair.resultPath).jpeg().withMetadata({ orientation: 6 }).toFile(rotatedPath);
    const result = await evaluateStudioConsistency(makeRequest(root, {
      result: { sha256: await fileSha(rotatedPath), objectPath: rotatedPath },
      references: [makeReference(root, { objectPath: pair.resultPath })],
    }));
    expect(["consistent", "needs-review"]).toContain(result.assets[0]?.verdict);
  });

  it("CMYK/灰度/16bit/alpha：自身可解码判定 + 对照原图构图保持", async () => {
    const root = await makeTempRoot();
    const pair = await writePair(root);
    const cmykPath = path.join(root, "cmyk.jpg");
    const grayPath = path.join(root, "gray.png");
    const sixteenPath = path.join(root, "16bit.png");
    const alphaPath = path.join(root, "alpha.png");
    await sharp(pair.resultPath).toColourspace("cmyk").jpeg().toFile(cmykPath);
    await sharp(pair.resultPath).greyscale().png().toFile(grayPath);
    await sharp(pair.resultPath).png({ bitdepth: 16 } as PngOptions).toFile(sixteenPath);
    await sharp(pair.resultPath).ensureAlpha(0.6).png().toFile(alphaPath);

    for (const [label, candidate] of [["CMYK", cmykPath], ["灰度", grayPath], ["16bit", sixteenPath], ["alpha 透明", alphaPath]] as const) {
      const self = await evaluateStudioConsistency(makeRequest(root, {
        result: { sha256: sha(Buffer.from(label)), objectPath: candidate },
        references: [makeReference(root, { objectPath: candidate, mediaSha256: sha(Buffer.from(`${label}-self`)) })],
      }));
      expect(self.assets[0]?.verdict, `${label} 自身对照`).toBe("consistent");

      const vsOriginal = await evaluateStudioConsistency(makeRequest(root, {
        result: { sha256: sha(Buffer.from(`${label}-vs`)), objectPath: candidate },
        references: [makeReference(root, { objectPath: pair.resultPath, mediaSha256: sha(Buffer.from(`${label}-ref`)) })],
      }));
      const composition = vsOriginal.assets[0]?.criteria.find((criterion) => criterion.code === "composition");
      expect(composition?.verdict, `${label} 对照原图构图`).toBe("consistent");
    }
  });
});

describe("P19 §7-4 evaluator 异常与 AbortSignal", () => {
  it("结果路径是目录（sharp 必抛）→ 无法检查 + 异常分类入证据", async () => {
    const root = await makeTempRoot();
    const pair = await writePair(root);
    const result = await evaluateStudioConsistency(makeRequest(root, {
      result: { sha256: "e".repeat(64), objectPath: root },
      references: [makeReference(root, { objectPath: pair.samePath })],
    }));
    expect(result.verdict).toBe("not-checkable");
    expect(result.evidence.errorClass).toBeTruthy();
  });

  it("AbortSignal 触发 → 无法检查且瞬态不缓存（同键可重试）", async () => {
    const root = await makeTempRoot();
    const pair = await writePair(root);
    const controller = new AbortController();
    controller.abort();
    const request = makeRequest(root, {
      references: [makeReference(root, { objectPath: pair.samePath })],
      signal: controller.signal,
    });
    const cancelled = await evaluateStudioConsistency(request);
    expect(cancelled.verdict).toBe("not-checkable");
    expect(cancelled.transient).toBe(true);

    const retried = await evaluateStudioConsistency(makeRequest(root, {
      references: [makeReference(root, { objectPath: pair.samePath })],
    }));
    expect(retried.verdict).toBe("consistent");
  });
});

describe("P19 §7-5 证据绑定与缓存键", () => {
  it("证据字段完整；输入变化 → 缓存 miss；computedAt 不进键（同键命中）", async () => {
    const root = await makeTempRoot();
    const pair = await writePair(root);
    const resultSha = await fileSha(pair.resultPath);
    const reference = makeReference(root, { objectPath: pair.samePath });
    const first = await evaluateStudioConsistency(makeRequest(root, {
      result: { sha256: resultSha, objectPath: pair.resultPath },
      references: [reference],
      now: () => "2026-07-19T00:00:00.000Z",
    }));
    expect(first.evidence.projectId).toBe("project-p19-test");
    expect(first.evidence.generationRunId).toBe("run-p19-test-1");
    expect(first.evidence.resultSha256).toBe(resultSha);
    expect(first.evidence.referenceSha256).toEqual([reference.mediaSha256]);
    expect(first.evidence.assetVersionIds).toEqual(["version-1"]);
    expect(first.evidence.packFingerprint).toBe("f".repeat(64));
    expect(first.evidence.evaluatorVersion).toMatch(/^p19-evaluator-/u);
    expect(first.evidence.configSha).toMatch(/^[a-f0-9]{64}$/u);

    const second = await evaluateStudioConsistency(makeRequest(root, {
      result: { sha256: resultSha, objectPath: pair.resultPath },
      references: [reference],
      now: () => "2026-07-20T00:00:00.000Z",
    }));
    expect(second.computedAt).toBe(first.computedAt);

    const changed = await evaluateStudioConsistency(makeRequest(root, {
      result: { sha256: resultSha, objectPath: pair.resultPath },
      references: [makeReference(root, { objectPath: pair.lightPath })],
      now: () => "2026-07-20T00:00:00.000Z",
    }));
    expect(changed.computedAt).toBe("2026-07-20T00:00:00.000Z");
  });

  it("冻结版本与现况 primaryAuthority 不一致 → stale 标记", async () => {
    const root = await makeTempRoot();
    const pair = await writePair(root);
    const result = await evaluateStudioConsistency(makeRequest(root, {
      references: [makeReference(root, { objectPath: pair.samePath, currentPrimaryAuthorityVersionId: "version-2-new" })],
    }));
    expect(result.assets[0]?.stale).toBe(true);
    expect(result.assets[0]?.reference.currentPrimaryAuthorityVersionId).toBe("version-2-new");
    expect(result.assets[0]?.verdict).toBe("consistent");
  });
});

describe("P19 §7-6 并发有界、同键去重、排队有界与同 scope 替换", () => {
  it("同键并发只算一次（全部返回同一对象）", async () => {
    const root = await makeTempRoot();
    const pair = await writePair(root);
    const request = makeRequest(root, { references: [makeReference(root, { objectPath: pair.samePath })] });
    const results = await Promise.all(Array.from({ length: 6 }, () => evaluateStudioConsistency(request)));
    for (const result of results) expect(result).toBe(results[0]);
  });

  it("pending 超 8 → 排队超限（可重试）；同 scope 新键替换未开始排队项", async () => {
    const root = await makeTempRoot();
    const pair = await writePair(root);
    const heavyPath = path.join(root, "heavy.png");
    await sharp(pair.resultPath).resize(2048, 2048).png().toFile(heavyPath);

    const makeHeavyRequest = (suffix: string, scope = `run-${suffix}`) =>
      makeRequest(root, {
        generationRunId: scope,
        result: { sha256: sha(Buffer.from(suffix)), objectPath: heavyPath },
        references: [makeReference(root, { objectPath: heavyPath, assetId: `asset-${suffix}`, mediaSha256: sha(Buffer.from(`media-${suffix}`)) })],
      });

    const overflowVerdicts = await Promise.all(
      Array.from({ length: 14 }, (_, index) =>
        evaluateStudioConsistency(makeHeavyRequest(`k${index}`)).then((result) => result.assets[0]?.criteria[0]?.note ?? result.verdict),
      ),
    );
    expect(overflowVerdicts.some((note) => String(note).includes("排队超限"))).toBe(true);

    resetStudioConsistencyEvaluatorForTests();
    const first = evaluateStudioConsistency(makeHeavyRequest("s1", "run-scope"));
    const second = evaluateStudioConsistency(makeHeavyRequest("s2", "run-scope"));
    const replaced = evaluateStudioConsistency(makeHeavyRequest("s3", "run-scope"));
    const replacer = evaluateStudioConsistency(makeHeavyRequest("s4", "run-scope"));
    const notes = await Promise.all([first, second, replaced, replacer].map(async (task) => (await task).assets[0]?.criteria[0]?.note ?? "ok"));
    expect(notes.some((note) => String(note).includes("被同范围新请求替换"))).toBe(true);
  });
});

describe("P19 §7-7 真实本地图冒烟组（存在守卫 + SHA 钉定）", () => {
  const authorityPath = "/Users/hxx/Desktop/豆姐参考图.png";
  const AUTHORITY_SHA = "02e9438ecee038f7d14860da37cb315bf358db4a26fa224e342eee5b592b55a9";

  it("权威图存在时：SHA 钉定 + 自身同图一致；结构硬锁输出无法检查+人工清单", async () => {
    const exists = await access(authorityPath).then(() => true, () => false);
    if (!exists) {
      console.warn("[p19] 权威图不存在，真实图冒烟组 skip（按存在守卫记录）");
      return;
    }
    const digest = createHash("sha256").update(await readFile(authorityPath)).digest("hex");
    expect(digest).toBe(AUTHORITY_SHA);

    const root = await makeTempRoot();
    const authorityDir = path.dirname(authorityPath);
    const result = await evaluateStudioConsistency(makeRequest(root, {
      projectRoot: authorityDir,
      result: { sha256: AUTHORITY_SHA, objectPath: authorityPath },
      references: [
        makeReference(root, {
          objectPath: authorityPath,
          category: "prop",
          structuralChecklist: ["平直微内凹额顶", "深色眉带", "杏仁眼孔", "长窄直鼻梁", "小闭口", "短圆下颏", "侧缘铆孔", "锤揲旧金"],
        }),
      ],
    }));
    expect(result.assets[0]?.verdict).toBe("consistent");
    const structural = result.assets[0]?.criteria.find((criterion) => criterion.code === "structural-locks");
    expect(structural?.verdict).toBe("not-checkable");
    expect(structural?.note).toContain("杏仁眼孔");
  });
});

describe("P25 复审补强：缓存键完备性与运行时异常瞬态化", () => {
  it("category/structuralChecklist/resultObjectPath 不同 → 缓存 miss（任一输入变即 stale）", async () => {
    const root = await makeTempRoot();
    const pair = await writePair(root);
    const base = makeRequest(root, {
      result: { sha256: await fileSha(pair.resultPath), objectPath: pair.resultPath },
      references: [makeReference(root, { objectPath: pair.samePath, category: "character", structuralChecklist: ["平直额顶"] })],
    });
    const first = await evaluateStudioConsistency({ ...base, now: () => "2026-07-21T00:00:00.000Z" });
    expect(first.computedAt).toBe("2026-07-21T00:00:00.000Z");

    // 同键复用 now=T2 仍命中（T1 时间戳）。
    const cached = await evaluateStudioConsistency({ ...base, now: () => "2026-07-21T01:00:00.000Z" });
    expect(cached.computedAt).toBe("2026-07-21T00:00:00.000Z");

    // category 变化 → 重算（此前旧键会误命中 character 结果）。
    const sceneRef = await evaluateStudioConsistency({
      ...base,
      references: [makeReference(root, { objectPath: pair.samePath, category: "scene", structuralChecklist: ["平直额顶"] })],
      now: () => "2026-07-21T02:00:00.000Z",
    });
    expect(sceneRef.computedAt).toBe("2026-07-21T02:00:00.000Z");

    // structuralChecklist 变化 → 重算。
    const checklist = await evaluateStudioConsistency({
      ...base,
      references: [makeReference(root, { objectPath: pair.samePath, category: "character", structuralChecklist: ["不同的结构项"] })],
      now: () => "2026-07-21T03:00:00.000Z",
    });
    expect(checklist.computedAt).toBe("2026-07-21T03:00:00.000Z");

    // resultObjectPath 变化（同 sha 不同路径）→ 重算。
    const otherPath = path.join(root, "result-copy.png");
    await writeBase(otherPath);
    const moved = await evaluateStudioConsistency({
      ...base,
      result: { sha256: await fileSha(pair.resultPath), objectPath: otherPath },
      now: () => "2026-07-21T04:00:00.000Z",
    });
    expect(moved.computedAt).toBe("2026-07-21T04:00:00.000Z");
  });

  it("运行时解码失败 → transient 不缓存，修复后重试成功；确定性拒绝（图过小）→ 非瞬态且缓存", async () => {
    const root = await makeTempRoot();
    const pair = await writePair(root);
    const corruptPath = path.join(root, "corrupt.png");
    await writeFile(corruptPath, Buffer.from("not a real png"));
    const request = makeRequest(root, {
      result: { sha256: "c".repeat(64), objectPath: corruptPath },
      references: [makeReference(root, { objectPath: pair.samePath })],
    });
    const failed = await evaluateStudioConsistency({ ...request, now: () => "2026-07-21T05:00:00.000Z" });
    expect(failed.verdict).toBe("not-checkable");
    expect(failed.transient).toBe(true);

    // 修复坏图后重试：不得命中缓存的旧失败（旧实现会把失败永久缓存）。
    await writeBase(corruptPath);
    const recovered = await evaluateStudioConsistency({
      ...request,
      result: { ...request.result, sha256: await fileSha(corruptPath) },
      now: () => "2026-07-21T06:00:00.000Z",
    });
    expect(recovered.computedAt).toBe("2026-07-21T06:00:00.000Z");
    expect(recovered.verdict).not.toBe("not-checkable");

    // 确定性输入拒绝（图过小 = ConsistencyInputError）：非瞬态，结果可缓存。
    const tinyPath = path.join(root, "tiny.png");
    await sharp({ create: { width: 8, height: 8, channels: 3, background: "#314653" } }).png().toFile(tinyPath);
    const tinyRequest = makeRequest(root, {
      result: { sha256: "d".repeat(64), objectPath: tinyPath },
      references: [makeReference(root, { objectPath: pair.samePath })],
    });
    const tinyFirst = await evaluateStudioConsistency({ ...tinyRequest, now: () => "2026-07-21T07:00:00.000Z" });
    expect(tinyFirst.verdict).toBe("not-checkable");
    expect(tinyFirst.transient).not.toBe(true);
    const tinyCached = await evaluateStudioConsistency({ ...tinyRequest, now: () => "2026-07-21T08:00:00.000Z" });
    expect(tinyCached.computedAt).toBe("2026-07-21T07:00:00.000Z");
  });

  it("声明 SHA 漂移与项目内符号链接均失败关闭，不能复用旧一致结论", async () => {
    const root = await makeTempRoot();
    const outsideRoot = await makeTempRoot();
    const pair = await writePair(root);
    const outsideReference = path.join(outsideRoot, "outside.png");
    await writeBase(outsideReference);
    const alias = path.join(root, "authority-alias.png");
    await symlink(outsideReference, alias);

    const valid = makeRequest(root, {
      result: { sha256: await fileSha(pair.resultPath), objectPath: pair.resultPath },
      references: [makeReference(root, { objectPath: pair.samePath })],
    });
    const shaDrift = await evaluateStudioConsistency({
      ...valid,
      references: [{ ...valid.references[0]!, mediaSha256: "0".repeat(64) }],
    });
    expect(shaDrift.verdict).toBe("not-checkable");
    expect(shaDrift.evidence.errorClass).toBe("sha256-mismatch");

    const symlinked = await evaluateStudioConsistency({
      ...valid,
      generationRunId: "run-symlink-reference",
      references: [{ ...valid.references[0]!, objectPath: alias, mediaSha256: await fileSha(outsideReference) }],
    });
    expect(symlinked.verdict).toBe("not-checkable");
    expect(symlinked.evidence.errorClass).toBe("symbolic-link-input");
  });
});
