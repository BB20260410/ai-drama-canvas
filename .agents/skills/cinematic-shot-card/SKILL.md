---
name: cinematic-shot-card
description: 将剧本/场景拆解为电影级分镜宫格 Shot Card 时使用。每镜包含景别、运镜、面部表情、对话、旁白、音效、情绪、光线、构图、时长等结构化字段。触发：分镜拆解、Shot Card、宫格分镜、镜头表、逐镜描述、分镜脚本、故事板字段。
---

# 电影级分镜宫格 Shot Card 系统

## 适用场景

- 将优化后的剧本拆解为 15 秒单元 × 2–6 宫格
- 为每个宫格生成结构化 Shot Card（含运镜/表情/对话/旁白）
- 为 imagegen pack 提供上游分镜字段
- 检查分镜的叙事完整性和视觉连贯性

## 与本项目权威链的关系

- Shot Card 是**文案层**结构化输出，供 `ai-drama-production-prompts` 消费
- 资产引用必须使用 `CanonicalAsset` ID，不发明新资产
- 连续性字段对接 `studio-continuity` 九字段
- 最终 imagegen prompt 由生产提示词 Skill 组装，本 Skill 只提供结构

---

## 一、Shot Card 完整字段定义

每个镜头（宫格）必须填写以下 **16 个字段**：

```yaml
shot_card:
  # === 基础标识 ===
  shot_id: "S01E03-004"          # 集-镜序号
  unit_id: "unit-s01e03-01"      # 所属 15s 单元
  grid_position: 3               # 宫格内位置（1-6）
  duration_sec: 2.5              # 本镜时长（秒）

  # === 画面构成 ===
  shot_size: "medium_close_up"   # 景别（见景别表）
  camera_angle: "eye_level"      # 机位角度
  camera_movement: "slow_push_in" # 运镜方式（见运镜库）
  composition: "rule_of_thirds_left" # 构图法则

  # === 人物表演 ===
  character_action: "右手缓缓抬起，指尖触碰面具边缘" # 可拍物理动作
  facial_expression: "micro_tension"  # 表情分级（见表情系统）
  expression_detail: "眉头微蹙，嘴角下压2mm，瞳孔轻微收缩" # 微表情描述

  # === 声音层 ===
  dialogue: "这面具……不是赝品。"  # 角色台词（含角色名）
  dialogue_delivery: "低声，气息不稳，尾音上扬" # 台词表演指示
  narration: null                # 旁白（null=无旁白）
  sound_design: "指尖触碰金属的清脆声 + 低频心跳加速" # 音效设计

  # === 氛围 ===
  emotion: "悬疑揭示"            # 本镜情绪关键词
  lighting: "rim_light_left"     # 光线方案
  color_grade: "cold_blue_steel" # 色彩基调

  # === 连续性 ===
  continuity_anchor:
    costume: "黑色高领毛衣 + 灰色风衣（未扣）"
    prop_state: "黄金面具在左手，正面朝向镜头"
    spatial_relation: "主角在画面左1/3，面具在右1/3"
    prev_shot_link: "S01E03-003 尾帧"
    next_shot_hint: "切至面具大特写"
```

---

## 二、景别标准表

| 代码 | 中文 | 英文 | 画面范围 | 叙事功能 |
|------|------|------|----------|----------|
| `extreme_wide` | 大远景 | Extreme Wide Shot | 人物占画面 <10% | 交代环境、史诗感、孤独 |
| `wide` | 远景/全景 | Wide Shot / Full Shot | 全身 + 环境 | 建立空间关系 |
| `medium_wide` | 中远景 | Medium Wide Shot | 膝盖以上 | 动作展示、群戏 |
| `medium` | 中景 | Medium Shot | 腰部以上 | 对话、日常动作 |
| `medium_close_up` | 中近景 | Medium Close-Up | 胸部以上 | 情绪传递、反应 |
| `close_up` | 近景/特写 | Close-Up | 面部填满画面 | 微表情、心理揭示 |
| `extreme_close_up` | 大特写 | Extreme Close-Up | 眼/唇/手/物件 | 戏剧张力、关键道具 |
| `insert` | 插入镜头 | Insert Shot | 特定细节 | 信息揭示、伏笔 |
| `pov` | 主观镜头 | POV Shot | 角色视角 | 代入感、悬疑 |
| `over_shoulder` | 过肩镜头 | Over-the-Shoulder | 前景肩+对方面 | 对话、对峙 |

---

## 三、机位角度表

| 代码 | 中文 | 效果 |
|------|------|------|
| `eye_level` | 平视 | 中性、客观 |
| `low_angle` | 仰拍 | 强大、压迫、英雄感 |
| `high_angle` | 俯拍 | 弱小、孤独、审视 |
| `birds_eye` | 鸟瞰 | 命运感、抽离 |
| `dutch_angle` | 荷兰角 | 不安、混乱、心理扭曲 |
| `worms_eye` | 蛙眼视角 | 极端仰视、恐惧 |
| `canted` | 倾斜 | 失衡、醉酒、梦境 |

---

## 四、对话/旁白/音效写作规范

### 对话字段规范

```yaml
dialogue: "【角色名】（表演指示）\n台词内容"
# 示例
dialogue: "【林若霜】（声音微颤，目光不离面具）\n这面具……不是赝品。"
```

**规则：**
- 单镜台词不超过 2 句（15 秒容量限制）
- 必须标注表演指示（语气/节奏/气息）
- 对话必须推动剧情或揭示人物（无功能对话删除）
- 多角色对话时标注说话顺序和反应镜头

### 旁白字段规范

```yaml
narration:
  type: "first_person"  # first_person / third_person / none
  speaker: "林若霜"
  text: "那一刻我知道，祖父留下的不只是一块金子。"
  timing: "覆盖本镜后 1.5 秒"
  tone: "低沉，回忆感，略带颤抖"
```

**规则：**
- 旁白不替代画面叙事（能用画面表达就不用旁白）
- 旁白必须提供画面无法传达的信息（时间跳跃/内心/反讽）
- 标注旁白与画面的时间关系

### 音效设计字段规范

```yaml
sound_design:
  layers:
    - type: "environment"    # 环境音底
      desc: "空旷展厅的回声底噪"
    - type: "action"         # 动作音
      desc: "指尖触碰金属的清脆叮声"
    - type: "emphasis"       # 强调音
      desc: "低频心跳从60bpm加速到90bpm"
    - type: "music"          # 配乐
      desc: "弦乐泛音渐入，悬疑色彩"
```

---

## 五、15 秒单元拆镜规则

### 宫格数量选择

| 宫格数 | 适用场景 | 平均单镜时长 |
|--------|----------|-------------|
| 2 格 | 对话正反打、对比蒙太奇 | 7.5s |
| 3 格 | 起承转（建立→发展→转折） | 5s |
| 4 格 | 标准叙事段落 | 3.75s |
| 5 格 | 快节奏动作/追逐 | 3s |
| 6 格 | 极快剪辑/蒙太奇/时间流逝 | 2.5s |

### 拆镜检查清单

- [ ] 景别是否有变化？（禁止连续 3 格相同景别）
- [ ] 运镜是否有动机？（无动机运镜 → 改为固定）
- [ ] 对白是否塞满？（15 秒最多 3 句短台词）
- [ ] 每格是否有明确叙事功能？（建立/推进/转折/高潮/收束）
- [ ] 连续性锚点是否完整？（服装/道具/空间/光线）
- [ ] 情绪是否有递进？（禁止 6 格同一情绪强度）

---

## 六、Shot Card 输出模板

```markdown
## S01E03 单元 01 · 15s · 4 宫格

### Grid 1/4 · 2.5s
| 字段 | 值 |
|------|-----|
| 景别 | 中远景 (medium_wide) |
| 机位 | 平视 (eye_level) |
| 运镜 | 缓慢横移右 (slow_track_right) |
| 构图 | 对称构图，主角居中 |
| 动作 | 林若霜推开展厅大门，逆光剪影 |
| 表情 | neutral_alert（平静中带警觉） |
| 表情细节 | 双眼微眯扫视，嘴唇轻抿 |
| 对话 | 无 |
| 旁白 | 无 |
| 音效 | 门轴转动金属声 + 展厅回声底噪 |
| 情绪 | 悬疑铺垫 |
| 光线 | 背光剪影，展厅内冷白顶光 |
| 色彩 | 冷灰蓝，低饱和 |
| 连续性 | 黑色高领+灰风衣（未扣），左手空 |

### Grid 2/4 · 4s
...（同上格式）
```

---

## 七、与下游的接口

| 下游消费者 | 需要的字段 |
|-----------|-----------|
| `ai-drama-production-prompts` | 全部 16 字段 → 组装 imagegen prompt |
| `cinematic-camera-movement` | camera_movement 字段 → 运镜提示词 |
| `facial-expression-system` | facial_expression + expression_detail → 表情提示词 |
| `studio-continuity` | continuity_anchor → 九字段连续性 |
| `studio-generation` | shot_id + unit_id → 冻结包关联 |

---

## 八、明确不做

- 不直接生成 imagegen prompt（由生产提示词 Skill 负责）
- 不绕过 BindingSet 消歧
- 不在 Shot Card 中写入模型参数（temperature/steps/cfg）
- 不把多格排版/字幕/水印写进单格描述
- 不替代导演审美判断——本 Skill 提供结构，创意选择归用户
