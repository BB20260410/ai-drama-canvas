import { copyFile, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";
import JSZip from "jszip";
import { parseNovelDocxIsolated } from "../src/core/novel-docx.js";

const temporaryRoots: string[] = [];
const require = createRequire(import.meta.url);
const mammothEntry = require.resolve("mammoth");
const mammothRoot = mammothEntry.slice(0, mammothEntry.lastIndexOf(`${path.sep}lib${path.sep}`));
const fixtureDocx = path.join(mammothRoot, "test", "test-data", "single-paragraph.docx");

async function temporaryDocx(name: string): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(await realpath(os.tmpdir()), "ai-canvas-novel-docx-")));
  temporaryRoots.push(root);
  const target = path.join(root, name);
  await copyFile(fixtureDocx, target);
  return target;
}

async function mutateDocx(
  target: string,
  mutate: (zip: JSZip) => void | Promise<void>,
): Promise<void> {
  const zip = await JSZip.loadAsync(await readFile(target));
  await mutate(zip);
  await writeFile(target, await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("novel DOCX isolated parser", () => {
  it("uses a read-only, no-network worker and extracts text from a real DOCX", async () => {
    const source = await temporaryDocx("source.docx");
    const result = await parseNovelDocxIsolated(source);

    expect(result.text.trim().length).toBeGreaterThan(0);
    expect(result.memberCount).toBeGreaterThan(0);
    expect(result.expandedBytes).toBeGreaterThan(0);
    expect(result.isolation).toEqual({
      process: true,
      permissionModel: true,
      networkAllowed: false,
      filesystemWriteAllowed: false,
    });
  });

  it("rejects DOCX packages with an external relationship", async () => {
    const source = await temporaryDocx("external-relation.docx");
    await mutateDocx(source, (zip) => {
      zip.file("_rels/aicanvas.rels", [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
        '<Relationship Id="evil" Type="https://example.invalid/type" Target="https://example.invalid/payload" TargetMode="External"/>',
        "</Relationships>",
      ].join(""));
    });

    await expect(parseNovelDocxIsolated(source)).rejects.toThrow(/外部关系/u);
  });

  it("rejects macro and embedded active-content members before conversion", async () => {
    const source = await temporaryDocx("macro.docx");
    await mutateDocx(source, (zip) => {
      zip.file("word/vbaProject.bin", Buffer.from("not-a-real-macro", "utf8"));
    });

    await expect(parseNovelDocxIsolated(source)).rejects.toThrow(/宏|ActiveX|嵌入对象/u);
  });

  it("enforces caller-tightened expansion limits inside the worker", async () => {
    const source = await temporaryDocx("expanded-limit.docx");
    await expect(parseNovelDocxIsolated(source, { maximumExpandedBytes: 1 }))
      .rejects.toThrow(/展开体积越界/u);
  });
});
