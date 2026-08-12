import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  executeIdempotentCommand,
  getNovelImportCommandOwnerRoot,
  type IdempotentCommandInput,
} from "../src/core/command-bus.js";
import {
  bindNovelDestinationToPreflightAuthorization,
  consumeNovelDestinationForPreflightAuthorization,
  consumeNovelDestinationSelection,
  issueNovelDestinationSelection,
  reserveNovelDestinationForPreflightAuthorization,
  resetNovelDestinationSelectionsForTests,
} from "../src/core/novel-destination-selection.js";
import {
  createAuthorizedNovelImportPreflightFromSelection,
  resetNovelImportPreflightAuthorizationsForTests,
} from "../src/core/novel-import.js";
import { NovelRepository } from "../src/core/novel-manuscript.js";
import type { NovelCommandRequest } from "../src/core/novel-command-runtime.js";
import {
  consumeNovelSourceSelection,
  issueNovelSourceSelection,
  resetNovelSourceSelectionsForTests,
} from "../src/core/novel-source-selection.js";
import {
  runWithOperationContext,
  type NovelImportDestinationExecutionIdentity,
} from "../src/core/operation-context.js";

const temporaryRoots: string[] = [];
const previousRegistryPath = process.env.AI_CANVAS_REGISTRY_PATH;

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function treeIdentity(root: string): Promise<string> {
  const rows: Array<Record<string, unknown>> = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = (await readdir(directory, { withFileTypes: true }))
      .sort((left, right) => Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)));
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const metadata = await lstat(absolute);
      rows.push({
        path: path.relative(root, absolute).split(path.sep).join("/"),
        type: metadata.isDirectory() ? "directory" : metadata.isFile() ? "file" : "other",
        size: metadata.size,
        sha256: metadata.isFile() ? sha256(await readFile(absolute)) : null,
      });
      if (metadata.isDirectory()) await visit(absolute);
    }
  };
  await visit(root);
  return sha256(JSON.stringify(rows));
}

async function desktopImportCapability(projectsRoot: string, sourcePath: string): Promise<{
  request: Extract<NovelCommandRequest, { command: "novel_import_external_snapshot" }>;
  destinationIdentity: NovelImportDestinationExecutionIdentity;
}> {
  const destination = await consumeNovelDestinationSelection(
    (await issueNovelDestinationSelection(projectsRoot)).destinationId,
  );
  const reservation = await reserveNovelDestinationForPreflightAuthorization(destination);
  const source = await consumeNovelSourceSelection(
    (await issueNovelSourceSelection(sourcePath, "file")).selectionId,
  );
  const authorized = await createAuthorizedNovelImportPreflightFromSelection(source);
  expect(authorized.authorization).not.toBeNull();
  await bindNovelDestinationToPreflightAuthorization(reservation, authorized.authorization!);
  const rebound = await consumeNovelDestinationForPreflightAuthorization(
    authorized.authorization!.authorizationId,
  );
  return {
    request: {
      command: "novel_import_external_snapshot",
      payload: {
        projectsRoot: rebound.projectsRoot,
        projectName: "桌面原生目标导入",
        preflightId: authorized.preflight.preflightId,
        preflightFingerprint: authorized.preflight.fingerprint,
        sourceTreeAggregateSha256: authorized.preflight.sourceTreeAggregateSha256,
        duplicateResolution: "include_all",
        convertToManagedMarkdown: true,
        preflightAuthorization: authorized.authorization!.authorizationId,
      },
    },
    destinationIdentity: {
      projectsRoot: rebound.projectsRoot,
      canonicalRoot: rebound.projectsRoot,
      dev: rebound.identity.dev,
      ino: rebound.identity.ino,
    },
  };
}

function envelope(label: string, request: NovelCommandRequest): IdempotentCommandInput {
  return {
    requestId: `novel-desktop-request-${label}`,
    idempotencyKey: `novel-desktop-idempotency-${label}`,
    request,
  };
}

afterEach(async () => {
  resetNovelImportPreflightAuthorizationsForTests();
  resetNovelSourceSelectionsForTests();
  resetNovelDestinationSelectionsForTests();
  if (previousRegistryPath === undefined) delete process.env.AI_CANVAS_REGISTRY_PATH;
  else process.env.AI_CANVAS_REGISTRY_PATH = previousRegistryPath;
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe.sequential("desktop novel destination command capability", () => {
  it("导入后合法编辑，fresh 新授权/新幂等键仍从选中 inode 证明历史 replay 且业务树不变", async () => {
    const base = await realpath(await mkdtemp(path.join(await realpath(os.tmpdir()), "novel-desktop-command-")));
    temporaryRoots.push(base);
    const appState = path.join(base, "app-state");
    const projectsRoot = path.join(base, "projects");
    const sourceRoot = path.join(base, "source");
    await Promise.all([mkdir(appState), mkdir(projectsRoot), mkdir(sourceRoot)]);
    process.env.AI_CANVAS_REGISTRY_PATH = path.join(appState, "projects.json");
    const sourcePath = path.join(sourceRoot, "第一卷.md");
    await writeFile(sourcePath, "# 第一章 神落\n\n嘟嘟在青铜树下醒来。\n", "utf8");

    const firstCapability = await desktopImportCapability(projectsRoot, sourcePath);
    const first = await executeIdempotentCommand(
      getNovelImportCommandOwnerRoot(),
      envelope("first-import", firstCapability.request),
      { novelImportDestinationIdentity: firstCapability.destinationIdentity },
    );
    expect(first).toMatchObject({ status: "succeeded", replayed: false });

    const projectEntry = (await readdir(projectsRoot, { withFileTypes: true }))
      .find((entry) => entry.isDirectory() && entry.name !== ".aicanvas-novel-import-transactions");
    expect(projectEntry).toBeDefined();
    const projectRoot = path.join(projectsRoot, projectEntry!.name);
    const repository = new NovelRepository(projectRoot);
    const beforeEdit = await repository.snapshot();
    const chapter = beforeEdit.chapters!.chapters[0]!;
    await runWithOperationContext({
      requestId: "novel-desktop-request-author-edit",
      idempotencyKey: "novel-desktop-idempotency-author-edit",
      requestHash: sha256("desktop-author-edit"),
      command: "novel_save_chapter",
    }, () => repository.saveChapter({
      chapterId: chapter.chapterId,
      content: "这是导入后作者合法保存的新正文。",
      expectedRevision: chapter.revision,
      expectedSha256: chapter.sha256,
    }));
    expect(await repository.readChapter(chapter.chapterId)).toMatchObject({
      status: "healthy",
      content: "这是导入后作者合法保存的新正文。",
    });
    const treeBeforeReplay = await treeIdentity(projectRoot);

    const replayCapability = await desktopImportCapability(projectsRoot, sourcePath);
    expect(replayCapability.request.payload.preflightFingerprint)
      .toBe(firstCapability.request.payload.preflightFingerprint);
    const replay = await executeIdempotentCommand(
      getNovelImportCommandOwnerRoot(),
      envelope("fresh-history-replay", replayCapability.request),
      { novelImportDestinationIdentity: replayCapability.destinationIdentity },
    );
    expect(replay).toMatchObject({ status: "succeeded", replayed: false });
    expect(replay.result).toMatchObject({ replayed: true });
    expect(await treeIdentity(projectRoot)).toBe(treeBeforeReplay);
    expect((await readdir(projectsRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && entry.name !== ".aicanvas-novel-import-transactions"))
      .toHaveLength(1);
  });
});
