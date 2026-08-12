import { describe, expect, it } from "vitest";
import { parseDynamicCards } from "../scripts/black-page-ch011-managed-writing-pilot.js";

describe("Black Page writing-state pilot mapping", () => {
  it("按章末协议保留八项动态卡和多行知情/关系，不把子项截断", () => {
    const cards = parseDynamicCards(`
### 【第010章结束后 · 易航】（L1）

- **身体状态**：夜班透支
- **情绪状态**：冷、短
- **已知信息**：
  - 093 是私人码线
  - 担保链短信存在
- **未知信息**：完整后台
- **关系进度**：
  - 阿大：师友
  - 肖龙：友情承压
- **新增目标**：先打账；收指
- **心理变化**：账不能只叠整齐
- **未解决矛盾**：是否回短信；是否拖肖龙下水

### 【第010章结束后 · 阿大】（L1）

- **身体状态**：腿旧伤
- **情绪状态**：损人护犊
- **已知信息**：催收与窗口须分线
- **未知信息**：黑页细节
- **关系进度**：易航：师友
- **新增目标**：盯易航别搅锅
- **心理变化**：既然沾了就按规矩走
- **未解决矛盾**：旧账未揭
`);
    expect(cards).toHaveLength(2);
    expect(cards[0]).toMatchObject({
      name: "易航",
      level: "L1",
      fields: {
        body: "夜班透支",
        known: ["093 是私人码线", "担保链短信存在"],
        relationships: ["阿大：师友", "肖龙：友情承压"],
        goals: ["先打账", "收指"],
        unresolved: ["是否回短信", "是否拖肖龙下水"],
      },
    });
  });
});
