import { describe, expect, it } from "vitest";
import {
  findSelectedStudioMultimediaPlaybackEntry,
  retainStudioMultimediaPlaybackSelection,
} from "../src/renderer/src/studio-multimedia-playback-selection.js";

const entries = [
  { id: "video:one", kind: "video" },
  { id: "audio:one", kind: "audio" },
] as const;

describe("Studio 多媒体播放选择", () => {
  it("没有用户选择时不回退到第一条正式媒体", () => {
    expect(findSelectedStudioMultimediaPlaybackEntry(entries, "")).toBeNull();
    expect(retainStudioMultimediaPlaybackSelection(entries, "")).toBe("");
  });

  it("只保留仍存在的显式选择", () => {
    expect(findSelectedStudioMultimediaPlaybackEntry(entries, "video:one"))
      .toBe(entries[0]);
    expect(retainStudioMultimediaPlaybackSelection(entries, "audio:one"))
      .toBe("audio:one");
  });

  it("切换单元或正式绑定消失后清空旧选择", () => {
    expect(findSelectedStudioMultimediaPlaybackEntry(entries, "video:missing")).toBeNull();
    expect(retainStudioMultimediaPlaybackSelection(entries, "video:missing")).toBe("");
  });
});
