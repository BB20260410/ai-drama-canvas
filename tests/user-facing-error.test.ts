import { describe, expect, it } from "vitest";
import { polishUserFacingText, toUserFacingErrorText } from "../src/renderer/src/user-facing-error.js";

describe("user-facing-error", () => {
  it("SQLite 锁库/ENOENT/权限翻译为可行动中文", () => {
    expect(toUserFacingErrorText(new Error("database is locked"))).toBe("数据正忙，请稍候再试一次。");
    expect(toUserFacingErrorText(new Error("ENOENT: no such file or directory, open '/tmp/x'"))).toBe("找不到需要的文件，请刷新后再试。");
    expect(toUserFacingErrorText(new Error("EACCES: permission denied"))).toBe("没有权限写入，请检查文件夹权限后重试。");
  });

  it("生产语义错误类逐条命中", () => {
    expect(toUserFacingErrorText(new Error("panel-run-in-flight: 宫格已有非终态 run"))).toContain("已有生成任务在进行中");
    expect(toUserFacingErrorText(new Error("run-cancelled"))).toContain("已取消");
    expect(toUserFacingErrorText(new Error("input-drift: Codex 请求必须携带"))).toContain("重新核对连线");
    expect(toUserFacingErrorText(new Error("continuity-drift"))).toContain("连续性校验未通过");
    expect(toUserFacingErrorText(new Error("fingerprint-conflict: 画布布局 fingerprint 不匹配"))).toContain("请刷新后再试");
  });

  it("已是中文的业务文案透传并做行内黑话替换", () => {
    expect(toUserFacingErrorText(new Error("画布资产连接与正式 BindingSet 不一致"))).toBe("画布资产连接与正式生成绑定不一致");
    expect(toUserFacingErrorText(new Error("一个 15 秒单元最多可固定 36 项素材"))).toBe("一个 15 秒单元最多可固定 36 项素材");
  });

  it("英文未知错误给兜底并附截断原文；空错误给纯兜底", () => {
    const text = toUserFacingErrorText(new Error("TypeError: weights[category] is undefined"));
    expect(text).toContain("操作没有完成");
    expect(text).toContain("TypeError");
    expect(toUserFacingErrorText("")).toBe("操作没有完成，请重试；多次失败请刷新页面。");
    expect(toUserFacingErrorText(new Error("x".repeat(300)))).toContain("…");
  });

  it("polishUserFacingText 行内替换", () => {
    expect(polishUserFacingText("AssetBindingSet 与 BindingSet 与 fingerprint")).toBe("生成绑定与生成绑定与版本指纹");
    expect(polishUserFacingText("一个 15 秒单元最多可固定 36 项素材")).toBe("一个 15 秒单元最多可固定 36 项素材");
  });
});
