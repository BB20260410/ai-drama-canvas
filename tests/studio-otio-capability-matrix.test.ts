import { describe, expect, it } from "vitest";
import {
  getStudioOtioCapabilityMatrix,
  probeStudioOtioDocument,
} from "../src/core/studio-otio-capability-matrix.js";

describe("studio-otio-capability-matrix（OpenTimelineIO OTIO-1）", () => {
  it("矩阵含本库支持的核心 schema", () => {
    const matrix = getStudioOtioCapabilityMatrix();
    expect(matrix.kind).toBe("studio-otio-capability-matrix");
    const bySchema = Object.fromEntries(matrix.rows.map((r) => [r.schema, r.level]));
    expect(bySchema["Timeline.1"]).toBe("supported");
    expect(bySchema["Clip.2"]).toBe("supported");
    expect(bySchema["Transition.1"]).toBe("partial");
    expect(bySchema["Marker.1"]).toBe("rejected");
  });

  it("probe 接受最小 Timeline 文档", () => {
    const doc = {
      OTIO_SCHEMA: "Timeline.1",
      name: "t",
      tracks: {
        OTIO_SCHEMA: "Stack.1",
        children: [
          {
            OTIO_SCHEMA: "Track.1",
            kind: "Video",
            children: [{ OTIO_SCHEMA: "Clip.2", name: "c1" }],
          },
        ],
      },
    };
    const probe = probeStudioOtioDocument(doc);
    expect(probe.ok).toBe(true);
    expect(probe.supportedSchemaHits).toContain("Clip.2");
    expect(probe.rejectedSchemaHits).toEqual([]);
  });

  it("probe 拒绝 Marker 与非 Timeline 根", () => {
    const bad = {
      OTIO_SCHEMA: "SerializableCollection.1",
      children: [{ OTIO_SCHEMA: "Marker.1" }],
    };
    const probe = probeStudioOtioDocument(bad);
    expect(probe.ok).toBe(false);
    expect(probe.issues.some((i) => i.includes("Timeline.1"))).toBe(true);
    expect(probe.rejectedSchemaHits).toContain("Marker.1");
  });
});
