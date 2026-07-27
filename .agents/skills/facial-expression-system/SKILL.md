---
name: facial-expression-system
description: 为 AI 短剧分镜提供面部表情/微表情分级描述体系。覆盖 6 大基础情绪 × 5 级强度、微表情细节写法、FACS 动作单元映射、表情提示词公式。触发：面部表情、微表情、表情描述、expression、情绪表演、FACS、表情分级、面部动作。
---

# 面部表情分级描述体系

## 适用场景

- 为 Shot Card 的 `facial_expression` 和 `expression_detail` 字段提供标准化描述
- 为 imagegen prompt 生成精准的表情提示词
- 确保角色表情在连续镜头中的递进合理性
- 检查表情描述是否"可拍"（禁止纯心理描述）

## 核心原则

1. **可拍性**：所有表情描述必须是摄影机能捕捉到的物理变化（禁止"他感到悲伤"）
2. **分级递进**：同一情绪有 5 级强度，镜头间表情必须有合理递进
3. **微表情优先**：电影级表演 = 微表情，不是夸张舞台表情
4. **区域拆分**：面部拆为 眉/眼/鼻/嘴/下颌/皮肤 六区域分别描述
5. **时间维度**：标注表情的持续时间和变化速度

---

## 一、6 大基础情绪 × 5 级强度

### 1. 快乐 / 喜悦（Joy）

| 级别 | 代码 | 眉区 | 眼区 | 嘴区 | 整体 | 英文关键词 |
|------|------|------|------|------|------|-----------|
| L1 微悦 | `joy_micro` | 自然放松 | 眼角极细纹 | 嘴角上扬1-2mm | 几乎不可察觉的愉悦 | subtle smile, hint of amusement |
| L2 浅笑 | `joy_mild` | 轻微上挑 | 眼轮匝肌微收 | 嘴角上扬，唇闭合 | 礼貌微笑 | gentle smile, soft eyes |
| L3 开心 | `joy_moderate` | 眉毛舒展 | 鱼尾纹明显，眼眯 | 露齿笑，嘴角大幅上扬 | 明显开心 | bright smile, crinkled eyes |
| L4 大笑 | `joy_intense` | 眉毛高挑 | 眼睛眯成缝 | 张口大笑，露上下齿 | 感染力笑 | laughing, eyes squeezed shut |
| L5 狂喜 | `joy_peak` | 眉毛极高 | 眼完全眯合+泪光 | 张口，头后仰 | 极度兴奋 | ecstatic, tears of joy, head thrown back |

### 2. 悲伤 / 哀痛（Sadness）

| 级别 | 代码 | 眉区 | 眼区 | 嘴区 | 整体 | 英文关键词 |
|------|------|------|------|------|------|-----------|
| L1 微伤 | `sadness_micro` | 眉心极轻聚 | 目光微微下垂 | 嘴角下压1mm | 一闪而过的落寞 | fleeting sadness, slight frown |
| L2 忧愁 | `sadness_mild` | 眉头轻蹙 | 目光黯淡，眨眼增多 | 嘴角下压，唇微抿 | 明显低落 | melancholy, downcast eyes |
| L3 悲伤 | `sadness_moderate` | 眉头紧锁，眉心上抬 | 眼眶泛红，泪光 | 嘴角明显下拉，下唇微颤 | 明显悲伤 | sorrowful, teary eyes, trembling lip |
| L4 痛哭 | `sadness_intense` | 眉头深锁 | 泪水滑落，眼红肿 | 嘴角大幅下拉，下唇外翻 | 哭泣 | crying, tears streaming, quivering chin |
| L5 崩溃 | `sadness_peak` | 眉头极度紧锁 | 泪流满面，眼闭合 | 张口嚎哭，面部扭曲 | 极度崩溃 | sobbing, face contorted, wailing |

### 3. 愤怒 / 暴怒（Anger）

| 级别 | 代码 | 眉区 | 眼区 | 嘴区 | 整体 | 英文关键词 |
|------|------|------|------|------|------|-----------|
| L1 微怒 | `anger_micro` | 眉心极轻聚 | 目光稍锐 | 唇微抿 | 一闪的不满 | subtle irritation, slight frown |
| L2 不悦 | `anger_mild` | 眉头下压 | 目光直视，瞳孔微缩 | 唇紧抿，下颌微收 | 明显不满 | displeased, narrowed eyes, tight lips |
| L3 愤怒 | `anger_moderate` | 眉头深锁下压 | 瞪视，眼白增多 | 唇紧压或微张，咬肌鼓起 | 明显愤怒 | angry, glaring, clenched jaw |
| L4 暴怒 | `anger_intense` | 眉头极度下压 | 圆睁，血丝 | 张口露齿或紧咬 | 爆发 | furious, bared teeth, bulging eyes |
| L5 狂怒 | `anger_peak` | 眉头锁死 | 眼极度圆睁 | 嘶吼/面部肌肉扭曲 | 失控 | enraged, screaming, veins visible |

### 4. 恐惧 / 惊恐（Fear）

| 级别 | 代码 | 眉区 | 眼区 | 嘴区 | 整体 | 英文关键词 |
|------|------|------|------|------|------|-----------|
| L1 微惧 | `fear_micro` | 眉毛微上挑 | 瞳孔微扩，眨眼 | 唇微张 | 一闪的不安 | subtle unease, slight widening |
| L2 紧张 | `fear_mild` | 眉毛上抬 | 眼微睁大，目光游移 | 唇轻抿或微张 | 明显紧张 | nervous, darting eyes, tense lips |
| L3 害怕 | `fear_moderate` | 眉毛高挑聚拢 | 眼明显睁大，眼白增多 | 微张口，下唇微颤 | 明显恐惧 | frightened, wide eyes, parted lips |
| L4 惊恐 | `fear_intense` | 眉毛极高 | 眼极度圆睁 | 张口，下颌下拉 | 惊骇 | terrified, eyes wide, mouth agape |
| L5 极恐 | `fear_peak` | 眉毛锁死上挑 | 眼最大开度，瞳孔极大 | 尖叫口型 | 极度恐惧 | horrified, frozen, screaming |

### 5. 惊讶 / 震惊（Surprise）

| 级别 | 代码 | 眉区 | 眼区 | 嘴区 | 整体 | 英文关键词 |
|------|------|------|------|------|------|-----------|
| L1 微讶 | `surprise_micro` | 眉毛微挑 | 眼微睁 | 唇微张 | 轻微意外 | slight surprise, raised brow |
| L2 意外 | `surprise_mild` | 眉毛上挑 | 眼睁大 | 口微张 | 明显意外 | surprised, widened eyes |
| L3 震惊 | `surprise_moderate` | 眉毛高挑 | 眼圆睁 | 口张开 | 明显震惊 | shocked, jaw dropped |
| L4 惊呆 | `surprise_intense` | 眉毛极高 | 眼最大 | 口大张 | 呆住 | stunned, frozen, mouth wide open |
| L5 震撼 | `surprise_peak` | 眉毛极挑 | 眼极圆+泪光 | 张口无声 | 极度震撼 | dumbfounded, speechless |

### 6. 厌恶 / 蔑视（Disgust / Contempt）

| 级别 | 代码 | 眉区 | 眼区 | 嘴区 | 鼻区 | 英文关键词 |
|------|------|------|------|------|------|-----------|
| L1 微厌 | `disgust_micro` | 单眉微挑 | 目光微偏 | 嘴角单侧微提 | 鼻翼微皱 | subtle contempt, slight sneer |
| L2 不屑 | `disgust_mild` | 眉微皱 | 目光下视/斜视 | 嘴角单侧上提 | 鼻轻皱 | disdainful, looking down |
| L3 厌恶 | `disgust_moderate` | 眉头皱 | 眼微眯 | 上唇上提，嘴角下拉 | 鼻明显皱 | disgusted, curled lip, wrinkled nose |
| L4 强烈厌恶 | `disgust_intense` | 眉深锁 | 眼眯合 | 上唇大幅上提，露齿 | 鼻深皱 | repulsed, bared upper teeth |
| L5 极度蔑视 | `disgust_peak` | 眉锁死 | 眼半闭斜视 | 吐舌/面部扭曲 | 鼻极度皱 | revulsion, face twisted |

---

## 二、复合表情（短剧高频）

| 代码 | 组合 | 描述 | 适用场景 |
|------|------|------|----------|
| `bitter_smile` | 快乐L2 + 悲伤L2 | 嘴角上扬但眼中含泪 | 强颜欢笑、离别 |
| `cold_fury` | 愤怒L3 + 快乐L1 | 嘴角微提但目光冰冷 | 反派微笑、威胁 |
| `fearful_surprise` | 恐惧L3 + 惊讶L3 | 眼睁大+口张+后退 | 突然惊吓 |
| `tender_sadness` | 快乐L1 + 悲伤L3 | 温柔微笑但泪滑落 | 释然、告别 |
| `nervous_joy` | 快乐L2 + 恐惧L2 | 笑但目光游移、手抖 | 紧张表白、心虚 |
| `contemptuous_pity` | 厌恶L2 + 悲伤L1 | 斜视+轻摇头+嘴角微提 | 居高临下的怜悯 |
| `frozen_horror` | 恐惧L4 + 惊讶L4 | 完全静止，只有瞳孔扩大 | 极度震惊定格 |
| `micro_tension` | 愤怒L1 + 恐惧L1 | 眉心微蹙+瞳孔微缩+唇抿 | 暗涌、警觉（最常用） |

---

## 三、微表情细节写法规范

### 六区域描述模板

```yaml
expression_detail:
  brow: "眉头微蹙，眉间距缩小约2mm"
  eyes: "瞳孔轻微收缩，上眼睑下压0.5mm，目光锁定不移"
  nose: "鼻翼无变化"
  mouth: "嘴角下压约2mm，下唇微收，唇线绷紧"
  jaw: "咬肌轻微鼓起，下颌微收"
  skin: "太阳穴血管微现（可选）"
  duration: "持续2秒后缓慢松弛"
  transition: "从neutral → micro_tension，过渡0.5秒"
```

### 写法禁忌

| 禁止写法 | 正确写法 | 原因 |
|----------|----------|------|
| "他很悲伤" | "眼眶泛红，下唇微颤，目光下垂" | 心理→物理 |
| "她意识到危险" | "瞳孔骤缩，呼吸加速，肩膀上提" | 内在→外在 |
| "表情复杂" | "嘴角上扬但眉头紧锁，眼中含泪" | 模糊→具体 |
| "面无表情" | "面部肌肉完全松弛，目光平视无焦点" | 消极→积极描述 |

---

## 四、表情提示词公式（imagegen 适配）

### 中文提示词公式

```
[景别]，[角色外貌锚点]，[表情代码对应的物理描述]，
[微表情细节1-2个区域]，[光线对表情的影响]，[情绪关键词]
```

### 英文提示词公式

```
[shot size], [character identity lock], [expression physical description],
[micro-detail: brow/eyes/mouth], [lighting on face], [mood keyword],
cinematic, shallow depth of field
```

### 示例

**中文：**
```
面部特写，30岁冷峻男子，黑色短发，眉头微蹙，
瞳孔轻微收缩，嘴角下压2mm，下唇绷紧，
右侧45度伦勃朗光在面颊投下三角形阴影，
悬疑紧张氛围，电影级质感
```

**英文：**
```
extreme close-up, 30-year-old stern man with short black hair,
subtle brow furrow, pupils slightly constricted,
corners of mouth pressed down 2mm, lower lip tense,
Rembrandt lighting from right 45 degrees casting triangle shadow on cheek,
suspenseful tense mood, cinematic, shallow depth of field, film grain
```

---

## 五、表情连续性规则

### 相邻镜头表情递进

| 镜头关系 | 规则 | 示例 |
|----------|------|------|
| 同场景连续 | 表情级别变化 ≤ 1 级 | L2→L3 可以，L1→L5 不行 |
| 正反打切换 | 双方表情需逻辑对应 | A愤怒L3 → B恐惧L2（合理） |
| 时间跳跃后 | 可跳级但需交代原因 | 插入事件后 L1→L4 |
| 同一单元内 | 必须有递进或对比 | 禁止 4 格同一表情级别 |

### 表情与景别匹配

| 景别 | 可表达的表情级别 | 原因 |
|------|-----------------|------|
| 大远景/远景 | 无法表达表情 | 距离太远 |
| 中景 | L3-L5（大幅度） | 只能看到大动作 |
| 中近景 | L2-L5 | 能看到基本表情 |
| 近景/特写 | L1-L5（全部） | 微表情最佳景别 |
| 大特写 | L1-L3（微妙） | 极致微表情 |

---

## 六、表情选择决策表

| 叙事节点 | 推荐表情 | 禁忌表情 |
|----------|----------|----------|
| 开场建立角色 | L1-L2（日常/微表情） | L4-L5（过度） |
| 激励事件 | surprise_L3 + fear_L2 | joy（不合时宜） |
| 冲突升级 | anger_L2→L3 递进 | 突然 L5（无铺垫） |
| 至暗时刻 | sadness_L4 / frozen_horror | joy（除非反讽） |
| 高潮对决 | anger_L4 / fear_L4 | L1（太平淡） |
| 温情收束 | tender_sadness / joy_L2 | anger（除非余怒） |
| 反派登场 | cold_fury / contempt_L2 | fear（除非假装） |

---

## 七、与 Shot Card 的接口

Shot Card 中表情字段填写规范：

```yaml
facial_expression: "micro_tension"  # 使用本系统代码
expression_detail: "眉头微蹙，瞳孔轻微收缩，嘴角下压2mm，下唇绷紧"
expression_intensity: 1.5  # 1-5 数值（允许小数表示过渡态）
expression_transition: "从 neutral(1.0) → micro_tension(1.5)，0.5秒过渡"
```

---

## 八、明确不做

- 不用纯心理描述替代物理描述
- 不在远景/全景中写微表情（看不到）
- 不让角色在无动机情况下表情跳级
- 不在单格中写超过 2 个表情变化（15 秒容量限制）
- 不替代演员/导演表演判断——本系统提供描述工具，创意选择归用户
