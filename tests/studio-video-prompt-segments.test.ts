import { describe, expect, it } from "vitest";
import {
  parseStudioVideoPromptSegments,
  validateStudioVideoPrompt,
} from "../src/core/studio-video-prompt-segments.js";
import { validateStudioShotDraft } from "../src/core/studio-shot-schema.js";

const GOOD = `0-3秒：近景，角色看手机。
3-6秒：全景，门铃响。
6-9秒：中景，角色起身。`;

describe("parseStudioVideoPromptSegments", () => {
  it("解析多段时码", () => {
    const r = parseStudioVideoPromptSegments(GOOD);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.segments).toHaveLength(3);
    expect(r.segments[0]).toMatchObject({ startSeconds: 0, endSeconds: 3 });
    expect(r.segments[2]!.body).toMatch(/起身/);
  });

  it("支持 <n> 分隔", () => {
    const r = parseStudioVideoPromptSegments(
      "0-3秒：A。<n>3-6秒：B。",
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.segments).toHaveLength(2);
  });

  it("空/无时码/重叠 fail-close", () => {
    expect(parseStudioVideoPromptSegments("").ok).toBe(false);
    expect(parseStudioVideoPromptSegments("没有时码的整段描述").ok).toBe(false);
    const overlap = parseStudioVideoPromptSegments("0-5秒：A。\n3-8秒：B。");
    expect(overlap.ok).toBe(false);
  });
});

describe("validateStudioVideoPrompt", () => {
  it("超过 15s 末段拒绝", () => {
    const r = validateStudioVideoPrompt("0-10秒：A。\n10-20秒：B。", { maxDurationSeconds: 15 });
    expect(r.ok).toBe(false);
  });

  it("接入 shot draft：合法 video_prompt 通过", () => {
    const r = validateStudioShotDraft({
      shotType: "medium",
      durationSeconds: 9,
      videoPrompt: GOOD,
    });
    expect(r.ok).toBe(true);
  });

  it("接入 shot draft：坏 video_prompt 拒绝", () => {
    const r = validateStudioShotDraft({
      videoPrompt: "纯文本无分段",
    });
    expect(r.ok).toBe(false);
  });

  it("requireVideoPromptSegments 时空 prompt 拒绝", () => {
    const r = validateStudioShotDraft({}, { requireVideoPromptSegments: true });
    expect(r.ok).toBe(false);
  });
});
