import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  validateStudioFreezePackExecutionContract,
  type StudioFreezePackExecutionContract,
} from "../src/core/studio-freeze-pack-execution-contract.js";
import {
  assertStudioExecutionFreezePackGate,
  assertStudioFormalGenerationPackDiscipline,
} from "../src/core/studio-generation-execution-gate.js";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

function minimalPack(over: Partial<StudioFreezePackExecutionContract> = {}): StudioFreezePackExecutionContract {
  const base: StudioFreezePackExecutionContract = {
    schemaVersion: 1,
    kind: "execution-freeze-pack",
    packId: "S1E2-U01:attempt:A1",
    dispatch_allowed: true,
    target: {
      targetKind: "unit-grid",
      unitId: "S1E2-U01",
      panelCount: 4,
      durationSeconds: 15,
      exactlyOneImage: true,
      maxCalls: 1,
      layout: "9:16-vertical-ordered-grid",
    },
    frameLock: { aspect_ratio: "9:16", orientation: "vertical" },
    styleLock: {
      code: "R-NIGHT",
      path: "/locks/R-NIGHT.jpg",
      sha256: sha("r-night"),
    },
    authority_lineage: "grok-original-20260723",
    controlReferences: [
      {
        role: "CHARACTER_IDENTITY",
        assetId: "char-dudu",
        path: "/locks/dudu.jpg",
        sha256: sha("dudu"),
        order: 1,
      },
    ],
    governance: {
      concurrency: 1,
      agentMayChooseRefs: false,
      agentMayRereadProject: false,
    },
  };
  return { ...base, ...over, target: { ...base.target, ...(over.target ?? {}) } };
}

describe("validateStudioFreezePackExecutionContract", () => {
  it("accepts a minimal valid S1E2 unit-grid pack", () => {
    const result = validateStudioFreezePackExecutionContract(minimalPack());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.pack.frameLock.aspect_ratio).toBe("9:16");
      expect(result.pack.target.exactlyOneImage).toBe(true);
      expect(result.pack.governance.concurrency).toBe(1);
    }
  });

  it("rejects 16:9 frame and multi-call packs", () => {
    const badFrame = validateStudioFreezePackExecutionContract(
      minimalPack({ frameLock: { aspect_ratio: "16:9" as "9:16" } }),
    );
    expect(badFrame.ok).toBe(false);
    if (!badFrame.ok) {
      expect(badFrame.issues.some((i) => i.code === "frameLock")).toBe(true);
    }

    const badCalls = validateStudioFreezePackExecutionContract(
      minimalPack({
        target: {
          targetKind: "unit-grid",
          unitId: "S1E2-U01",
          panelCount: 4,
          durationSeconds: 15,
          exactlyOneImage: true,
          maxCalls: 2 as 1,
          layout: "9:16-vertical-ordered-grid",
        },
      }),
    );
    expect(badCalls.ok).toBe(false);
  });

  it("rejects agent that may reread full project or choose refs", () => {
    const result = validateStudioFreezePackExecutionContract(
      minimalPack({
        governance: {
          concurrency: 1,
          agentMayChooseRefs: true as false,
          agentMayRereadProject: false,
        },
      }),
    );
    expect(result.ok).toBe(false);
  });

  it("rejects empty controlReferences (text-only)", () => {
    const result = validateStudioFreezePackExecutionContract({
      ...minimalPack(),
      controlReferences: [],
    });
    expect(result.ok).toBe(false);
  });

  it("execution gate throws on invalid pack and accepts valid pack", () => {
    expect(() => assertStudioExecutionFreezePackGate(minimalPack())).not.toThrow();
    expect(() => assertStudioExecutionFreezePackGate({ kind: "nope" })).toThrow(/纪律门禁/);
  });

  it("formal pack discipline requires controlReferences (wired freeze gate)", () => {
    expect(() => assertStudioFormalGenerationPackDiscipline({ request: { controlReferences: [{ a: 1 }] } })).not.toThrow();
    expect(() => assertStudioFormalGenerationPackDiscipline({ request: { controlReferences: [] } })).toThrow(
      /controlReferences/,
    );
  });
});
