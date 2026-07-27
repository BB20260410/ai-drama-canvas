import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { verifyApprovedTimelineMedia } from "../src/core/studio-approved-timeline-media-verify.js";
import { createStudioP7Fixture, type StudioP7Fixture } from "./helpers/studio-p7-fixture.js";

/**
 * T10 批量媒体 CAS 核验核心测试：
 * - 已导入媒体验证通过；缺失对象记 stat 失败；内容不符记 hash-mismatch；
 * - 大文件走流式哈希，结果与一次性哈希一致（缺陷 3 修复验证）；
 * - 占位符/非法 SHA 一律跳过（不验证、不冒充通过）；
 * - 缓存键（objectPath + SHA+mtime+size）命中语义不变。
 * 全部 mkdtemp 隔离工程，不触碰真实受管工程。
 */

const fixtures: StudioP7Fixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
});

async function p7(): Promise<StudioP7Fixture> {
  const fixture = await createStudioP7Fixture();
  fixtures.push(fixture);
  return fixture;
}

/** 把内容写入工程 CAS 的 SHA 寻址路径（仅测试夹具内）。 */
async function writeCasObject(casRoot: string, sha256: string, content: Buffer): Promise<string> {
  const objectPath = path.join(casRoot, sha256.slice(0, 2), sha256);
  await mkdir(path.dirname(objectPath), { recursive: true });
  await writeFile(objectPath, content);
  return objectPath;
}

describe("T10 verifyApprovedTimelineMedia", () => {
  it("已导入媒体通过；缺失对象记 stat 失败", async () => {
    const fixture = await p7();
    const realSha = fixture.panelMediaPairs[0]!.raw.imported.sha256;
    const missingSha = "ab".repeat(32);
    const result = await verifyApprovedTimelineMedia(fixture.root, {
      unitShaMap: [{ unitId: "unit-a", sha256List: [realSha, missingSha] }],
    });
    expect(result.totalUniqueSha).toBe(2);
    const unit = result.units[0]!;
    expect(unit.passed).toEqual([realSha]);
    expect(unit.failures).toHaveLength(1);
    expect(unit.failures[0]!.sha256).toBe(missingSha);
    expect(unit.failures[0]!.stage).toBe("stat");
    expect(result.failed).toBe(1);
  }, 120_000);

  it("大文件流式哈希与一次性哈希一致（验证通过）", async () => {
    const fixture = await p7();
    // 8 MiB 确定性内容（远超旧实现一次性 readFile 的内存路径，流式哈希必须给出同一 SHA）
    const content = Buffer.alloc(8 * 1024 * 1024);
    for (let index = 0; index < content.length; index += 1) content[index] = index % 251;
    const sha = createHash("sha256").update(content).digest("hex");
    const casRoot = fixture.shell.paths.mediaCas;
    await writeCasObject(casRoot, sha, content);

    const result = await verifyApprovedTimelineMedia(fixture.root, {
      unitShaMap: [{ unitId: "unit-big", sha256List: [sha], tier: "raw" }],
    });
    expect(result.failed).toBe(0);
    expect(result.units[0]!.passed).toEqual([sha]);
    // 二次调用命中进程内缓存（SHA+mtime+size 三元组），结果仍通过
    const cached = await verifyApprovedTimelineMedia(fixture.root, {
      unitShaMap: [{ unitId: "unit-big", sha256List: [sha], tier: "raw" }],
    });
    expect(cached.cacheHits).toBe(1);
    expect(cached.units[0]!.passed).toEqual([sha]);
  }, 120_000);

  it("CAS 对象内容与寻址 SHA 不符记 hash-mismatch", async () => {
    const fixture = await p7();
    const expectedSha = createHash("sha256").update("t10-expected-content", "utf8").digest("hex");
    await writeCasObject(fixture.shell.paths.mediaCas, expectedSha, Buffer.from("t10-tampered-content", "utf8"));
    const result = await verifyApprovedTimelineMedia(fixture.root, {
      unitShaMap: [{ unitId: "unit-c", sha256List: [expectedSha] }],
    });
    expect(result.units[0]!.passed).toEqual([]);
    expect(result.units[0]!.failures).toHaveLength(1);
    expect(result.units[0]!.failures[0]!.stage).toBe("hash-mismatch");
  }, 120_000);

  it("占位符/非法 SHA 跳过：不验证、不计入通过", async () => {
    const fixture = await p7();
    const realSha = fixture.panelMediaPairs[0]!.labeled.imported.sha256;
    const result = await verifyApprovedTimelineMedia(fixture.root, {
      unitShaMap: [{
        unitId: "unit-d",
        sha256List: ["pending-sha-resolution", "", "not-a-sha", realSha],
      }],
    });
    expect(result.totalUniqueSha).toBe(1);
    expect(result.units[0]!.passed).toEqual([realSha]);
    expect(result.units[0]!.failures).toEqual([]);
  }, 120_000);
});
