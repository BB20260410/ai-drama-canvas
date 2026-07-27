import { describe, expect, it } from "vitest";
import { calculateTimelineMove, calculateTimelineTrimEnd, calculateTimelineTrimStart, quantizeTimelineTime, snapTimelineTime, timelineFrameForSeconds, timelineFrameRate, timelineReorderIndex, timelineSecondsForFrame } from "../src/renderer/src/timeline-interaction.js";

describe("导演剪辑台时间线交互", () => {
  it("在阈值内吸附到最近边缘，超出阈值保持原时间", () => {
    expect(snapTimelineTime(4.92, [2, 5, 8], 0.1)).toEqual({ value: 5, snappedTo: 5 });
    expect(snapTimelineTime(4.7, [2, 5, 8], 0.1)).toEqual({ value: 4.7, snappedTo: undefined });
  });

  it("自由拖动不会越过时间线边界，并能吸附播放头", () => {
    expect(calculateTimelineMove({ initialStart: 2, deltaSeconds: 2.94, durationSeconds: 2, totalDuration: 12, snapTargets: [5], snapThresholdSeconds: 0.1 })).toEqual({ value: 5, snappedTo: 5 });
    expect(calculateTimelineMove({ initialStart: 9, deltaSeconds: 4, durationSeconds: 2, totalDuration: 12, snapTargets: [], snapThresholdSeconds: 0.1 }).value).toBe(10);
  });

  it("视频左侧裁切同时更新时间线起点、时长和源片裁切起点", () => {
    expect(calculateTimelineTrimStart({
      initialStart: 4,
      initialDuration: 6,
      initialTrimStart: 1,
      playbackRate: 2,
      deltaSeconds: 1,
      mediaCanTrim: true,
      snapTargets: [],
      snapThresholdSeconds: 0.1,
    })).toEqual({ startSeconds: 5, durationSeconds: 5, trimStartSeconds: 3, snappedTo: undefined });
  });

  it("向左延长媒体时不会越过源片零点", () => {
    const patch = calculateTimelineTrimStart({
      initialStart: 4,
      initialDuration: 6,
      initialTrimStart: 1,
      playbackRate: 2,
      deltaSeconds: -3,
      mediaCanTrim: true,
      snapTargets: [],
      snapThresholdSeconds: 0.1,
    });
    expect(patch.startSeconds).toBe(3.5);
    expect(patch.trimStartSeconds).toBe(0);
    expect(patch.durationSeconds).toBe(6.5);
  });

  it("右侧裁切吸附边缘且遵守最小时长和最大终点", () => {
    expect(calculateTimelineTrimEnd({ initialStart: 3, initialDuration: 4, deltaSeconds: 1.96, maximumEnd: 10, snapTargets: [9], snapThresholdSeconds: 0.1 })).toEqual({ durationSeconds: 6, snappedTo: 9 });
    expect(calculateTimelineTrimEnd({ initialStart: 3, initialDuration: 4, deltaSeconds: 20, maximumEnd: 10, snapTargets: [], snapThresholdSeconds: 0.1 }).durationSeconds).toBe(7);
    expect(calculateTimelineTrimEnd({ initialStart: 3, initialDuration: 4, deltaSeconds: -20, maximumEnd: 10, snapTargets: [], snapThresholdSeconds: 0.1 }).durationSeconds).toBe(0.1);
  });

  it("主画面拖动按片段中心确定新的插入位置", () => {
    const peers = [{ startSeconds: 0, durationSeconds: 2 }, { startSeconds: 2, durationSeconds: 3 }, { startSeconds: 5, durationSeconds: 2 }];
    expect(timelineReorderIndex(peers, 0.5)).toBe(0);
    expect(timelineReorderIndex(peers, 3.8)).toBe(2);
    expect(timelineReorderIndex(peers, 9)).toBe(3);
  });

  it("24000/1001 时间基下拖动、裁切与吸附始终落在整数帧", () => {
    const frameRate = timelineFrameRate({ fps: 23.976, timebase: { rateNumerator: 24_000, rateDenominator: 1_001 } });
    expect(frameRate).toBeCloseTo(23.976023976, 8);
    expect(quantizeTimelineTime(.5, frameRate)).toBe(.5);
    expect(timelineSecondsForFrame(12, frameRate)).toBe(.5);
    expect(timelineFrameForSeconds(.5, frameRate)).toBe(12);

    const moved = calculateTimelineMove({ initialStart: 0, deltaSeconds: .49, durationSeconds: 1.001, totalDuration: 4.004, snapTargets: [], snapThresholdSeconds: .02, frameRate });
    expect(moved.value).toBe(.5);
    expect(timelineSecondsForFrame(timelineFrameForSeconds(moved.value, frameRate), frameRate)).toBe(moved.value);

    const trimmed = calculateTimelineTrimStart({ initialStart: 1.001, initialDuration: 2.002, initialTrimStart: 0, playbackRate: 1, deltaSeconds: .49, mediaCanTrim: true, snapTargets: [], snapThresholdSeconds: .02, frameRate });
    for (const value of [trimmed.startSeconds, trimmed.durationSeconds, trimmed.trimStartSeconds]) {
      expect(timelineSecondsForFrame(timelineFrameForSeconds(value, frameRate), frameRate)).toBe(value);
    }
  });
});
