import { describe, expect, it } from "vitest";
import {
  isStudioCommandRequest,
  type CommandRequest,
} from "../src/core/command-bus.js";

describe("Studio 命令路由唯一分类器", () => {
  it("覆盖章节修订与生成账本命令，拒绝 legacy/非 Studio 写面", () => {
    const accepted: CommandRequest[] = [
      {
        command: "append_studio_script_section_revision",
        payload: {
          sectionId: "scene-001",
          expectedRevision: 0,
          kind: "scene",
          title: "石室",
          scriptRevisionId: "script-revision-001",
          scriptSha256: "c".repeat(64),
          startOffsetUtf16: 0,
          endOffsetUtf16: 2,
        },
      },
      {
        command: "freeze_studio_generation_pack",
        payload: { unitId: "unit-001", panelId: "panel-01", expectedRevision: 0 },
      },
      {
        command: "register_studio_generation_result",
        payload: {
          packId: "pack-001",
          packFingerprint: "a".repeat(64),
          generationRunId: "run-001",
          variant: "raw",
          mediaSha256: "b".repeat(64),
          expectedRevision: 0,
        },
      },
    ];
    expect(accepted.every((request) => isStudioCommandRequest(request))).toBe(true);
    expect(isStudioCommandRequest({
      command: "submit_review",
      payload: { itemId: "legacy" },
    } as unknown as CommandRequest)).toBe(false);
    expect(isStudioCommandRequest({ command: "scan_project", payload: {} })).toBe(false);
  });
});
