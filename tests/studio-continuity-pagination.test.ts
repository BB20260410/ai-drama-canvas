import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createManagedProject } from "../src/core/managed-project.js";
import {
  appendStudioContinuityObservation,
  listOpenStudioContinuityConflictPage,
  listOpenStudioContinuityConflicts,
  queryStudioContinuityTimelinePage,
} from "../src/core/studio-continuity-ledger.js";
import {
  getStudioProductionDashboard,
  type StudioDashboardQueuePage,
} from "../src/core/studio-production-dashboard.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("studio continuity SQL keyset pagination", () => {
  it("在 528 个开放冲突下稳定深分页，并让驾驶舱读取第 500 项之后的队列", async () => {
    const parent = await realpath(await mkdtemp(path.join(os.tmpdir(), "studio-continuity-page-")));
    roots.push(parent);
    const root = (await createManagedProject({ parentRoot: parent, name: "连续性深分页" })).paths.root;
    const scopeAnchor = {
      kind: "panel" as const,
      scopeId: "panel-page-001",
      unitId: "unit-page-001",
      unitRevision: 1,
    };

    // 33 个同 anchor/subject/field、互相重叠且状态各异的 current head：C(33, 2) = 528 conflicts。
    for (let index = 0; index < 33; index += 1) {
      await appendStudioContinuityObservation(root, {
        operationId: `page-observation-${String(index).padStart(2, "0")}`,
        expectedHeadRevision: 0,
        scope: {
          ...scopeAnchor,
          startMilliseconds: index,
          endMilliseconds: 15_000 - index,
        },
        subjectId: "character-pagination",
        field: "costume",
        state: {
          status: "resolved",
          value: `服装状态-${String(index).padStart(2, "0")}`,
          provenance: [{ kind: "pagination-fixture", reference: `state-${index}` }],
        },
      });
    }

    const seenConflictIds: string[] = [];
    let conflictCursor: string | undefined;
    for (let pageIndex = 0; pageIndex < 6; pageIndex += 1) {
      const page = await listOpenStudioContinuityConflictPage(root, {
        scopeAnchor,
        subjectId: "character-pagination",
        field: "costume",
        cursor: conflictCursor,
        limit: 100,
      });
      expect(page.total).toBe(528);
      seenConflictIds.push(...page.items.map((item) => item.id));
      conflictCursor = page.nextCursor;
      if (!conflictCursor) break;
    }
    expect(seenConflictIds).toHaveLength(528);
    expect(new Set(seenConflictIds).size).toBe(528);
    expect(seenConflictIds).toEqual([...seenConflictIds].sort((left, right) => left.localeCompare(right, "en")));
    expect(await listOpenStudioContinuityConflicts(root, {
      scopeAnchor,
      subjectId: "character-pagination",
      field: "costume",
      offset: 500,
      limit: 28,
    })).toHaveLength(28);

    // 取精确 500 项后的 owner cursor，交给 Dashboard，证明不再固定看最早 500 项。
    let afterFiveHundred: string | undefined;
    let cursor: string | undefined;
    for (let pageIndex = 0; pageIndex < 5; pageIndex += 1) {
      const page = await listOpenStudioContinuityConflictPage(root, {
        cursor,
        limit: 100,
      });
      cursor = page.nextCursor;
    }
    afterFiveHundred = cursor;
    expect(afterFiveHundred).toBeTruthy();
    const dashboardTail = await getStudioProductionDashboard(root, {
      operation: "queue",
      queue: "conflict",
      cursor: afterFiveHundred,
      limit: 36,
    }) as StudioDashboardQueuePage;
    expect(dashboardTail.page.total).toBe(528);
    expect(dashboardTail.page.items).toHaveLength(28);
    expect(dashboardTail.page.items[0]!.id).toBe(seenConflictIds[500]);
    expect(dashboardTail.page.nextCursor).toBeUndefined();

    const firstTimeline = await queryStudioContinuityTimelinePage(root, {
      scopeAnchor,
      subjectId: "character-pagination",
      field: "costume",
      limit: 17,
    });
    const secondTimeline = await queryStudioContinuityTimelinePage(root, {
      scopeAnchor,
      subjectId: "character-pagination",
      field: "costume",
      cursor: firstTimeline.nextCursor,
      limit: 17,
    });
    expect(firstTimeline.total).toBe(33);
    expect(firstTimeline.items).toHaveLength(17);
    expect(secondTimeline.items).toHaveLength(16);
    expect(new Set([...firstTimeline.items, ...secondTimeline.items].map((item) => item.headKey)).size).toBe(33);
    expect(secondTimeline.fingerprint).toBe((await queryStudioContinuityTimelinePage(root, {
      scopeAnchor,
      subjectId: "character-pagination",
      field: "costume",
      cursor: firstTimeline.nextCursor,
      limit: 17,
    })).fingerprint);
    await expect(queryStudioContinuityTimelinePage(root, {
      scopeAnchor,
      subjectId: "other-character",
      field: "costume",
      cursor: firstTimeline.nextCursor,
      limit: 17,
    })).rejects.toMatchObject({ code: "invalid-input" });
  }, 120_000);
});
