import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { executeIdempotentCommand, type IdempotentCommandInput } from "../src/core/command-bus.js";
import { createManagedProject } from "../src/core/managed-project.js";
import {
  buildNovelContextPack,
  compareNovelWritingSourceReceipts,
  doctorNovelAgent,
  getNovelWritingState,
  listNovelWritingSourceReceipts,
} from "../src/core/novel-agent-service.js";
import { executeNovelAgentJsonRequest } from "../src/core/novel-agent-json.js";
import {
  createAuthorizedNovelImportPreflight,
  resetNovelImportPreflightAuthorizationsForTests,
} from "../src/core/novel-import.js";

const roots: string[] = [];
let sequence = 0;

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

afterEach(async () => {
  resetNovelImportPreflightAuthorizationsForTests();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function envelope(command: string, payload: Record<string, unknown>): IdempotentCommandInput {
  sequence += 1;
  return {
    requestId: `writing-source-request-${sequence}-${randomUUID()}`,
    idempotencyKey: `writing-source-key-${sequence}-${randomUUID()}`,
    request: { command, payload },
  } as IdempotentCommandInput;
}

async function treeIdentity(root: string): Promise<string> {
  const rows: Array<Record<string, unknown>> = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)));
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      const metadata = await lstat(absolute);
      rows.push({
        relative,
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

async function treeContainsText(root: string, needle: string): Promise<boolean> {
  const visit = async (directory: string): Promise<boolean> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (await visit(absolute)) return true;
      } else if (entry.isFile() && (await readFile(absolute)).includes(Buffer.from(needle, "utf8"))) return true;
    }
    return false;
  };
  return visit(root);
}

describe("Novel writing source snapshot bridge", () => {
  it("只读快照外部资料、由 owner 原子绑定 Story Bible，并在源目录删除后仍可正式组包", async () => {
    const parent = await realpath(await mkdtemp(path.join(await realpath(os.tmpdir()), "novel-writing-source-")));
    roots.push(parent);
    const sourceRoot = path.join(parent, "外部资料");
    const projectsRoot = path.join(parent, "projects");
    await Promise.all([mkdir(sourceRoot), mkdir(projectsRoot)]);
    await mkdir(path.join(sourceRoot, "设定"));
    await writeFile(path.join(sourceRoot, "设定", "人物锁.md"), "易航右眉尾有一道浅疤，不得无故消失。\n", "utf8");
    await writeFile(path.join(sourceRoot, "时间线.md"), "D4：担保链露一指。\n", "utf8");
    await writeFile(path.join(sourceRoot, "旧资料.md"), "即将退役的旧版说明。\n", "utf8");
    const sourceBefore = await treeIdentity(sourceRoot);

    const shell = await createManagedProject({ parentRoot: projectsRoot, name: "资料桥夹具", workspaceMode: "novel" });
    const initialized = await executeIdempotentCommand(shell.paths.root, envelope("novel_initialize_manuscript", {
      sourceMode: "managed_markdown",
    }));
    let manifest = (initialized.result as { chapters: { revision: number; volumes: Array<{ volumeId: string }> } }).chapters;
    const volumeId = manifest.volumes[0]!.volumeId;
    const chapters: Array<{ chapterId: string; revision: number; sha256: string }> = [];
    for (const [title, content] of [["第001章", "基线章。"], ["第002章", ""]] as const) {
      const created = await executeIdempotentCommand(shell.paths.root, envelope("novel_create_chapter", {
        volumeId,
        title,
        content,
        expectedManifestRevision: manifest.revision,
      }), { novelWriteActor: "human_ui" });
      const result = created.result as {
        chapter: { chapterId: string; revision: number; sha256: string };
        manifest: { revision: number; volumes: Array<{ volumeId: string }> };
      };
      chapters.push(result.chapter);
      manifest = result.manifest;
    }

    const authorized = await createAuthorizedNovelImportPreflight(sourceRoot);
    expect(authorized.authorization).not.toBeNull();
    const importEnvelope = envelope("novel_import_writing_source_snapshot", {
      preflightId: authorized.preflight.preflightId,
      preflightFingerprint: authorized.preflight.fingerprint,
      sourceTreeAggregateSha256: authorized.preflight.sourceTreeAggregateSha256,
      preflightAuthorization: authorized.authorization!.authorizationId,
    });
    await expect(executeIdempotentCommand(shell.paths.root, importEnvelope)).rejects.toMatchObject({
      result: expect.objectContaining({ reason: "actor_forbidden" }),
    });
    const imported = await executeIdempotentCommand(shell.paths.root, importEnvelope, { novelWriteActor: "human_owner" });
    const receipt = (imported.result as {
      receipt: {
        receiptId: string;
        fingerprint: string;
        objects: Array<{
          sourceRelativePath: string;
          textObjectRelativePath: string;
          suggestedSourceId: string;
        }>;
      };
    }).receipt;
    expect(JSON.stringify(imported.result)).not.toContain(sourceRoot);
    expect(await treeIdentity(sourceRoot)).toBe(sourceBefore);
    expect(await treeContainsText(shell.paths.root, sourceRoot)).toBe(false);

    const listed = await listNovelWritingSourceReceipts(shell.paths.root);
    expect(listed.receipts).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain(sourceRoot);
    await expect(executeNovelAgentJsonRequest({
      schemaVersion: 1,
      operation: "list_writing_source_receipts",
      projectRoot: shell.paths.root,
    })).resolves.toMatchObject({
      operation: "list_writing_source_receipts",
      data: { receipts: [{ receiptId: receipt.receiptId }] },
    });
    const appearanceObject = receipt.objects.find((entry) => entry.sourceRelativePath === "设定/人物锁.md");
    if (!appearanceObject) throw new Error("缺少人物锁资料对象");

    await rename(path.join(sourceRoot, "设定", "人物锁.md"), path.join(sourceRoot, "设定", "人物外形锁.md"));
    await writeFile(path.join(sourceRoot, "时间线.md"), "D4：担保链露一指；D5：收到第二张回执。\n", "utf8");
    await rm(path.join(sourceRoot, "旧资料.md"));
    await writeFile(path.join(sourceRoot, "未纳管补丁.md"), "新增但尚未绑定的资料。\n", "utf8");
    const authorizedCurrent = await createAuthorizedNovelImportPreflight(sourceRoot);
    const importedCurrent = await executeIdempotentCommand(shell.paths.root, envelope("novel_import_writing_source_snapshot", {
      preflightId: authorizedCurrent.preflight.preflightId,
      preflightFingerprint: authorizedCurrent.preflight.fingerprint,
      sourceTreeAggregateSha256: authorizedCurrent.preflight.sourceTreeAggregateSha256,
      preflightAuthorization: authorizedCurrent.authorization!.authorizationId,
    }), { novelWriteActor: "human_owner" });
    const currentReceipt = (importedCurrent.result as { receipt: { receiptId: string } }).receipt;
    const compared = await compareNovelWritingSourceReceipts(shell.paths.root, {
      baseReceiptId: receipt.receiptId,
      currentReceiptId: currentReceipt.receiptId,
    });
    expect(compared.summary).toEqual({ unchanged: 0, modified: 1, renamed: 1, deleted: 1, untracked: 1 });
    expect(compared.diff.renamed[0]).toMatchObject({
      fromSourceRelativePath: "设定/人物锁.md",
      toSourceRelativePath: "设定/人物外形锁.md",
      detection: "unique_text_identity",
    });
    expect(JSON.stringify(compared)).not.toContain(sourceRoot);
    await expect(executeNovelAgentJsonRequest({
      schemaVersion: 1,
      operation: "compare_writing_source_receipts",
      projectRoot: shell.paths.root,
      input: {
        baseReceiptId: receipt.receiptId,
        currentReceiptId: currentReceipt.receiptId,
      },
    })).resolves.toMatchObject({
      operation: "compare_writing_source_receipts",
      data: { summary: { unchanged: 0, modified: 1, renamed: 1, deleted: 1, untracked: 1 } },
    });

    const seeded = await executeIdempotentCommand(shell.paths.root, envelope("novel_seed_writing_state", {
      baselineStatus: "locked",
      sourceTreeAggregateSha256: sha256("legacy-seed"),
      currentThroughChapterId: chapters[0]!.chapterId,
      sourceDocuments: [{ sourceId: "owner-seed", displayPath: "基线/owner声明.md", content: "owner 初始化声明。" }],
      entities: [],
      hardCanon: [],
      characterStates: [],
      knowledge: [],
      relationships: [],
      timeline: [],
      foreshadowing: [],
      chapterBriefs: [],
      completedChapterIds: [chapters[0]!.chapterId],
    }), { novelWriteActor: "human_owner" });
    const initialState = (seeded.result as { state: { revision: number; fingerprint: string } }).state;
    const staged = await executeIdempotentCommand(shell.paths.root, envelope("novel_stage_story_bible_candidate", {
      expectedWritingStateRevision: initialState.revision,
      expectedWritingStateFingerprint: initialState.fingerprint,
      summary: "绑定一次性资料快照并登记未来章硬正典",
      changes: [
        {
          changeId: "bind-appearance-source",
          kind: "source_binding",
          reason: "把 owner 选定的资料快照绑定为可追溯证据",
          value: {
            receiptId: receipt.receiptId,
            receiptFingerprint: receipt.fingerprint,
            sourceRelativePath: appearanceObject.sourceRelativePath,
            sourceId: appearanceObject.suggestedSourceId,
          },
        },
        {
          changeId: "canon-brow-scar",
          kind: "hard_canon",
          reason: "将资料中的明确外形事实登记为写作正典",
          value: {
            ruleId: "canon-yihang-brow-scar",
            text: "易航右眉尾有一道浅疤，不得无故消失。",
            priority: 100,
            canonStatus: "canon",
            visibility: "writer",
            effectiveFromChapterId: chapters[1]!.chapterId,
            sourceIds: [appearanceObject.suggestedSourceId],
          },
        },
        {
          changeId: "brief-chapter-002",
          kind: "chapter_brief",
          reason: "明确本章无角色出场，仅验证来源闭包",
          value: {
            chapterId: chapters[1]!.chapterId,
            summary: "核验担保链资料。",
            mustDo: ["保持来源可追溯"],
            mustNotDo: ["回读外部目录补事实"],
            requiredCharacterIds: [],
            sourceIds: [appearanceObject.suggestedSourceId],
          },
        },
      ],
    }));
    const candidate = (staged.result as { candidate: { candidateId: string; fingerprint: string } }).candidate;
    await executeIdempotentCommand(shell.paths.root, envelope("novel_review_story_bible_candidate", {
      candidateId: candidate.candidateId,
      expectedCandidateFingerprint: candidate.fingerprint,
      expectedWritingStateRevision: initialState.revision,
      expectedWritingStateFingerprint: initialState.fingerprint,
      decision: "accepted",
      reviewer: "human-owner",
    }), { novelWriteActor: "human_owner" });

    const projected = await getNovelWritingState(shell.paths.root, {
      targetChapterId: chapters[1]!.chapterId,
      cutoff: "before",
    });
    expect(projected.temporal.hardCanon).toContainEqual(expect.objectContaining({ ruleId: "canon-yihang-brow-scar" }));
    const packBeforeDelete = await buildNovelContextPack(shell.paths.root, {
      taskType: "continue_chapter",
      targetChapterId: chapters[1]!.chapterId,
      workflowMode: "formal",
      maxCharacters: 4096,
    });
    if (!("dependencies" in packBeforeDelete)) throw new Error("预期 Context Pack 2.0");
    expect(packBeforeDelete.dependencies.sourceClosure).toMatchObject({ provenance: "receipt_bound" });

    await rm(sourceRoot, { recursive: true, force: true });
    const packAfterDelete = await buildNovelContextPack(shell.paths.root, {
      taskType: "continue_chapter",
      targetChapterId: chapters[1]!.chapterId,
      workflowMode: "formal",
      maxCharacters: 4096,
    });
    expect(packAfterDelete.fingerprint).toBe(packBeforeDelete.fingerprint);

    await writeFile(path.join(shell.paths.root, appearanceObject.textObjectRelativePath), "篡改。", "utf8");
    const doctor = await doctorNovelAgent(shell.paths.root, { targetChapterId: chapters[1]!.chapterId, workflowMode: "formal" });
    expect(doctor.readyForPrepare).toBe(false);
    expect(doctor.blockers).toContainEqual(expect.objectContaining({ code: "writing_source_integrity_mismatch" }));
    await expect(buildNovelContextPack(shell.paths.root, {
      taskType: "continue_chapter",
      targetChapterId: chapters[1]!.chapterId,
      workflowMode: "formal",
      maxCharacters: 4096,
    })).rejects.toMatchObject({
      result: expect.objectContaining({ reason: "writing_source_integrity_mismatch" }),
    });
  });
});
