# 人物实体提取与视觉设计闸门

## 目标

先把小说、剧本、推文和情节中的人物与非人实体整理成可追溯账本，再做视觉设计。原文事实、未知项、设计提案和批准后的硬锁必须分开。

## 强制流程

1. 按来源和段落顺序扫描所有明确出现或被指代的实体，包括第一人称“我”。
2. 合并姓名、外号、身份称谓和关系称谓；证据不足的代称保持独立并标记 `ambiguous`。
3. 分类为 `human`、`deity`、`immortal`、`demon`、`monster`、`spirit`、`ghost`、`system`、`collective` 或 `unknown`。
4. 每条明确事实记录来源位置和支持字段；没有证据的字段进入 `unknown_fields`。
5. 根据身份、时代和剧情提出视觉方案时，只写入 `design_proposal`，不得直接写入硬锁。
6. 人工批准或既有 Authority 明确后，才把提案提升为 canonical lock。

## 输出合同

默认输出合法 JSON；`aliases`、`evidence`、`unknown_fields` 和 `conflicts` 必须是数组，不用逗号拼接字符串。

```json
{
  "schema_version": "character-entity-ledger/v1",
  "characters": [
    {
      "character_id": "C01",
      "name": "我",
      "aliases": ["我"],
      "entity_type": "human",
      "identity_resolution": "resolved",
      "evidence": [
        {
          "source": "小说原文",
          "location": "第1段",
          "text": "原文证据摘录",
          "supports": ["name"]
        }
      ],
      "explicit_facts": {},
      "unknown_fields": ["age", "height", "eye_color"],
      "conflicts": [],
      "design_proposal": {},
      "visualization_policy": "required",
      "approval_status": "unresolved"
    }
  ]
}
```

## 事实与设计边界

- `explicit_facts`：原文明确写出，或既有受管资产已批准的事实。
- `unknown_fields`：原文未说明且当前没有 Authority 的字段；保留未知，不填“合理值”。
- `design_proposal`：为出图提出的年龄感、脸型、配色、服装、发型或体型方案；必须标为提案。
- `conflicts`：同一身份存在互斥称谓、年龄、外貌、装备或时序证据时记录，禁止静默选一个。
- `approval_status`：只用 `unresolved`、`proposed`、`approved`、`rejected`。

## 非人实体规则

- “系统、面板、空间、商城、签到”等先按叙事功能登记，不自动画成精灵、光团、机械球或人形。
- 使用 `visualization_policy: not_visualized | ui_only | voice_only | symbolic | physical_entity | unresolved`。
- 只有原文或人工决定要求可见实体时，才生成实体外观方案。
- 神、魔、仙、怪、妖、鬼等按当前项目世界观分类；称谓相似不等于同一身份。

## 角色视觉提案

提案可包含年龄感、性别呈现、身高印象、脸型、发色发型、眼睛、体态、主色、服装层级、鞋履、背面结构、标志物和材质。遵守：

- 时代、地域、阶层和剧情优先于“角色必须好看”。
- 角色区分优先使用轮廓、材质、层级和标志物，不为区分而改写 canon。
- 武器、法宝、神器和关键道具必须有原文证据或已批准 Authority。
- `locked` 与 `scene_changeable` 分开；表情、战损、污渍、持物和姿态通常属于场景状态。

## 参考图生产

正式参考图按面部、正面全身、侧面、背面和必要道具分别生成单张 raw；每张只含一个明确任务。文字信息、编号和设定板排版由本地排版器添加。模型补出的不可见侧面或背面只能是 `proposed`，审片批准前不能作为 canonical identity。

## 验收

- 每个合并后的身份都有证据，代称冲突未被静默吞掉。
- 所有未知字段仍为 unknown，所有推断仍为 proposal。
- 非人辅助存在没有被自动实体化。
- 武器、法宝和关键道具有来源或批准记录。
- JSON 可解析，数组字段类型正确。
- 未批准候选没有进入 BindingSet、硬锁或后续正式生图包。
