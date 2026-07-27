import { describe, expect, it } from "vitest";
import {
  acceptStudioImagegenCandidateBytes,
  assertStudioImagegenCandidatePathAllowed,
  filterStudioImagegenCandidateSearchHits,
  resolveStudioImagegenPromptDelivery,
  StudioImagegenCandidateGateError,
} from "../src/core/studio-imagegen-candidate-gate.js";

const grant = {
  rootPath: "/proj/.aicanvas/studio-generation/quarantine/studio-imagegen-call-abc",
  candidatePath:
    "/proj/.aicanvas/studio-generation/quarantine/studio-imagegen-call-abc/candidate.png",
  receiptPath:
    "/proj/.aicanvas/studio-generation/quarantine/studio-imagegen-call-abc/execution-receipt.json",
};

describe("studio-imagegen-candidate-gate", () => {
  it("只接受精确 quarantine candidate 路径", () => {
    const ok = assertStudioImagegenCandidatePathAllowed(grant, grant.candidatePath);
    expect(ok).toBe(grant.candidatePath);
  });

  it("拒绝 prop authority 与其它非 quarantine PNG", () => {
    expect(() => assertStudioImagegenCandidatePathAllowed(
      grant,
      "/proj/.aicanvas/mvp-work/prop-qingdeng-lantern-authority.png",
    )).toThrow(StudioImagegenCandidateGateError);

    expect(() => assertStudioImagegenCandidatePathAllowed(
      grant,
      "/proj/.aicanvas/studio-generation/quarantine/studio-imagegen-call-abc/other.png",
    )).toThrow(/candidate-path-mismatch|candidatePath/);
  });

  it("搜索命中只保留 quarantine 精确路径", () => {
    const hit = filterStudioImagegenCandidateSearchHits(grant, [
      { path: "/proj/.aicanvas/mvp-work/prop-qingdeng-lantern-authority.png", size: 1_000_057 },
      { path: grant.candidatePath, size: 250_000 },
    ]);
    expect(hit).toEqual({ path: grant.candidatePath, size: 250_000 });

    const none = filterStudioImagegenCandidateSearchHits(grant, [
      { path: "/proj/.aicanvas/mvp-work/prop-qingdeng-lantern-authority.png", size: 1_000_057 },
    ]);
    expect(none).toBeNull();
  });

  it("验收候选字节并拒绝过小文件", () => {
    expect(acceptStudioImagegenCandidateBytes(grant, grant.candidatePath, 100_000))
      .toEqual({ accepted: true, candidatePath: grant.candidatePath, bytes: 100_000 });
    expect(() => acceptStudioImagegenCandidateBytes(grant, grant.candidatePath, 100))
      .toThrow(/候选过小|candidate-too-small/);
  });

  it("prompt 必须走 stdin 投递，禁止空 prompt", () => {
    const delivery = resolveStudioImagegenPromptDelivery({
      promptText: "generate one 9:16 grid",
      promptFilePath: "/tmp/prompt.txt",
    });
    expect(delivery).toMatchObject({ mode: "stdin", argvPrompt: false });
    expect(() => resolveStudioImagegenPromptDelivery({ promptText: "  " }))
      .toThrow(StudioImagegenCandidateGateError);
  });
});
