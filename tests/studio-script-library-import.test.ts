import { mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertImportTargetNotReadonlyAuthority,
  deriveScriptTitleFromPath,
  importStudioScriptLibraryFiles,
} from "../src/core/studio-script-library-import.js";
import { createManagedProject } from "../src/core/managed-project.js";
import {
  initializeStudioProduction,
  listStudioTextDocuments,
  listStudioTextRevisions,
} from "../src/core/studio-production.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("studio-script-library-import pure guards", () => {
  it("deriveScriptTitleFromPath strips extension", () => {
    expect(deriveScriptTitleFromPath("/tmp/S1E2_立约.md")).toBe("S1E2_立约");
    expect(deriveScriptTitleFromPath("foo.TXT")).toBe("foo");
  });

  it("rejects write into SOURCE_SCRIPT_READONLY roots", () => {
    expect(() =>
      assertImportTargetNotReadonlyAuthority(
        path.join("/Users/hxx/Documents", "无限画布", "productions", "x", "SOURCE_SCRIPT_READONLY"),
      ),
    ).toThrow(/权威只读/);
  });

  it("allows managed project roots", () => {
    expect(() =>
      assertImportTargetNotReadonlyAuthority(
        "/Users/hxx/Documents/无限画布/projects/dudu-gaiden-lock-20260723-12a6516c",
      ),
    ).not.toThrow();
  });

  it("imports multiple scripts, appends same-title versions, deduplicates CAS, and never writes the source", async () => {
    const parent = await realpath(await mkdtemp(path.join(os.tmpdir(), "script-library-import-")));
    roots.push(parent);
    const projectRoot = (await createManagedProject({ parentRoot: parent, name: "剧本库导入" })).paths.root;
    await initializeStudioProduction(projectRoot);
    const source = path.join(parent, "EP01.md");
    await writeFile(source, "# EP01\n第一版。第二句。", "utf8");

    const first = await importStudioScriptLibraryFiles(projectRoot, { files: [source] });
    expect(first).toMatchObject({ imported: 1, skippedDuplicate: 0, failed: 0 });
    const documentId = first.files[0]?.documentId;
    expect(documentId).toBeTruthy();

    const duplicate = await importStudioScriptLibraryFiles(projectRoot, { files: [source] });
    expect(duplicate).toMatchObject({ imported: 0, skippedDuplicate: 1, failed: 0 });
    expect(duplicate.files[0]?.documentId).toBe(documentId);

    await writeFile(source, "# EP01\n第二版。又一句。", "utf8");
    const sourceBeforeImport = await readFile(source, "utf8");
    const statBeforeImport = await stat(source);
    const second = await importStudioScriptLibraryFiles(projectRoot, { files: [source] });
    const statAfterImport = await stat(source);
    expect(second).toMatchObject({ imported: 1, skippedDuplicate: 0, failed: 0 });
    expect(second.files[0]?.documentId).toBe(documentId);
    expect(await readFile(source, "utf8")).toBe(sourceBeforeImport);
    expect(statAfterImport.mtimeMs).toBe(statBeforeImport.mtimeMs);

    const docs = await listStudioTextDocuments(projectRoot, { kind: "script", limit: 20 });
    expect(docs.items).toHaveLength(1);
    expect(docs.items[0]).toMatchObject({ id: documentId, revision: 2 });
    const revisions = await listStudioTextRevisions(projectRoot, { documentId: documentId!, limit: 20 });
    expect(revisions.items).toHaveLength(2);
    expect(new Set(revisions.items.map((revision) => revision.bodySha256)).size).toBe(2);
  });
});
