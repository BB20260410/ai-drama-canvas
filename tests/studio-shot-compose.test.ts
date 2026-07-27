import { describe, expect, it } from "vitest";
import { buildMinimalSrtFromDialogue, planStudioShotCompose } from "../src/core/studio-shot-compose.js";

describe("planStudioShotCompose", () => {
  it("视频+TTS+SRT 就绪", () => {
    const plan = planStudioShotCompose({
      visualPath: "static/clips/u01.mp4",
      visualKind: "video",
      ttsAudioPath: "static/tts/u01.mp3",
      srtContent: "1\n00:00:00,000 --> 00:00:03,000\n你好\n",
      outputFileName: "u01-composed.mp4",
    });
    expect(plan.readyForFfmpeg).toBe(true);
    expect(plan.hasSubtitle).toBe(true);
    expect(plan.steps.some((s) => s.includes("TTS"))).toBe(true);
    expect(plan.blockers).toEqual([]);
  });

  it("静帧缺时长则未就绪", () => {
    const plan = planStudioShotCompose({
      visualPath: "stills/a.png",
      visualKind: "still",
      outputFileName: "a.mp4",
    });
    expect(plan.readyForFfmpeg).toBe(false);
    expect(plan.blockers.join(" ")).toMatch(/durationSeconds/);
  });

  it("非 mp4 扩展名只警告不阻塞", () => {
    const plan = planStudioShotCompose({
      visualPath: "/abs/a.png",
      visualKind: "still",
      outputFileName: "a.mov",
      durationSeconds: 2,
    });
    expect(plan.readyForFfmpeg).toBe(true);
    expect(plan.warnings.join(" ")).toMatch(/\.mp4/);
    expect(plan.blockers).toEqual([]);
  });

  it("拒绝路径穿越输出名", () => {
    expect(() =>
      planStudioShotCompose({
        visualPath: "a.mp4",
        visualKind: "video",
        outputFileName: "../evil.mp4",
      }),
    ).toThrow(/\.\./);
  });
});

describe("buildMinimalSrtFromDialogue", () => {
  it("生成单 cue SRT", () => {
    const srt = buildMinimalSrtFromDialogue("开场白", 3);
    expect(srt).toContain("开场白");
    expect(srt).toMatch(/00:00:03,000/);
  });
});
