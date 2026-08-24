---
name: cinematic-shot-card
description: 将锁版剧本或场景拆解为可生成、可验收的电影级 Shot Card 与真实时长 2–6 格故事板时使用。显式分离原文证据、单一可画静态瞬间、视频运动/转场、口播预算、声音/文字与连续性状态。触发：分镜拆解、Shot Card、宫格分镜、镜头表、逐镜描述、分镜脚本、故事板字段、静态画面与运镜分离。
---

# 电影级分镜宫格 Shot Card 系统

## 运行时边界与下游职责

- 项目内 `AGENTS.md`、唯一合同、锁版剧本、正典裁决和机器状态优先于本 Skill
- Shot Card 是**文案层**结构化输出，供 `ai-drama-production-prompts` 消费
- 资产引用必须使用 `CanonicalAsset` ID，不发明新资产
- 连续性字段对接 `studio-continuity` 九字段
- 最终 imagegen prompt 由生产提示词 Skill 组装，本 Skill 只提供结构
- 15 秒只是常用单元；锁版源若明确为 12 秒或其他时长，保持真实时长，不为套模板而改写
- 不把扩写、补桥或镜头建议冒充锁版原文；新增内容必须标为 `proposed`

---

## 一、拆镜前先冻结输入

每个单元先记录：

- `source_evidence`：原文文件、段落/镜号、版本或内容哈希
- `unit_duration_sec`：项目真实时长
- `completed_beats / current_beats / reserved_beats`：已发生、本单元发生、以后才发生
- `canonical_locks`：人物、服装、道具、场景拓扑、时代、光线与禁项
- `spatial_rule_ref`：多镜头连续单元或项目已有全局空间规则时，引用连续性卡中的规则；单镜头且没有既有规则时可为 `null`，只写本镜局部 `spatial_relation`。需要新规则时交由连续性 owner 建立，不在 Shot Card 里另写总图
- `unresolved`：不能从原文或权威文件确定、需要裁决的项目

一个单元包含两个不可逆事件、多个空间跳转或互相冲突的动作时，先拆单元；不得把后续事件提前塞进当前宫格。

## 二、Shot Card 字段组

每个镜头（宫格）按以下字段组填写。不要声称固定“16 字段”；不同项目可增加机器字段，但这些语义必须保持分离：

```yaml
shot_card:
  identity:
    shot_id: "S01E03-U01-G03"
    unit_id: "S01E03-U01"
    grid_position: 3
    duration_sec: 2.5
    source_evidence: "锁版剧本镜04：触碰面具边缘"
    spatial_rule_ref: "CSR-EXHIBIT-HALL-01"

  static_frame:
    shot_size: "medium_close_up"
    camera_angle: "eye_level"
    composition: "rule_of_thirds_left"
    drawable_state: "右手指尖刚接触面具边缘；动作只冻结在接触瞬间"
    facial_expression: "micro_tension"
    expression_detail: "眉头轻蹙，嘴角收紧，视线落在接触点"
    spatial_relation: "人物居左三分之一，面具居右三分之一"
    lighting: "left_rim_light"
    color_grade: "cold_blue_steel"

  video_plan:
    shot_structure: "continuous_take_with_phases"
    subject_motion: "从手停在胸前推进到指尖接触后立即停住"
    prop_motion: "面具由左手稳定托住，不发生自主位移"
    environment_motion: "展厅环境静止，仅尘粒轻微漂浮"
    camera_movement: "slow_push_in"
    motion_owners:
      subject: "林若霜"
      prop: "左手与面具绑定"
      camera: "摄影机"
      environment: "展厅空气"
    transition_in: "承接上一镜人物已站定"
    transition_out: "切至面具接触点大特写"

  audio_text:
    dialogue: "【林若霜】（低声，气息不稳）这面具……不是赝品。"
    narration: null
    timing_status: "ready"
    timing_blocker: null
    proposed_dialogue_change: null
    proposed_narration_change: null
    speech_budget:
      budget_sec: 2.0
      estimated_speech_sec: 1.6
      pause_sec: 0.4
      performance_action_sec: 0.5
      concurrency: "full_overlap"
      overlap_sec: 0.5
      estimate_basis: "project_voice_sample"
    sound_design:
      layers:
        - type: "action"
          desc: "指尖触碰金属的清脆声"
        - type: "emphasis"
          desc: "低频心跳渐强"
    burn_in_raw: false

  continuity_anchor:
    costume: "黑色高领毛衣 + 灰色风衣（未扣）"
    prop_state: "黄金面具在左手，正面朝向镜头"
    planned_start_state: "右手停在胸前，尚未触碰面具"
    planned_end_state: "右手指尖接触面具边缘"
    observed_end_state_ref: null
    prev_shot_link: "仅可引用已验收尾帧"
    forbidden: ["换脸", "换装", "面具变形", "额外人物", "文字或UI"]
```

`static_frame.drawable_state` 只能描述一张图可冻结的瞬间；“走近、抬手、触碰、转身、离开”这类动作链必须拆分，或写入 `video_plan`。`shot_structure` 由 Shot Card 唯一判断：`continuous_take_with_phases` 是一个连续镜头内分阶段运动，`editorial_multishot` 是有明确切点的多镜组接，`transition_matched_cut` 是由动作、视线、声音、遮挡或构图匹配完成的连续切换；阶段语法和硬切语法不得混写。多人、洪水或道具交互等复杂运动在既有 `motion_owners` 下分别指定 subject / prop / camera / environment，不建立第二份运动合同。

Shot Card 唯一拥有本镜 `duration_sec`、单元故事板格数、事件边界、`planned_start_state` 与 `planned_end_state`；下游技能不得另设“20秒默认6/9格”等平行默认。它不保存观测 payload。原尺寸审片通过后，只把连续性卡或受管 Review 记录的唯一引用写入 `observed_end_state_ref`。

`speech_budget` 永远测量当前 `audio_text.dialogue / narration` 中的锁版或已授权文本，不得拿候选短稿的测算冒充原稿测算。`timing_status: ready` 的镜头才可进入最终提交包，并统一满足：

- `duration_sec > 0`
- `budget_sec >= 0`、`estimated_speech_sec >= 0`、`pause_sec >= 0`、`performance_action_sec >= 0`
- `estimated_speech_sec + pause_sec <= budget_sec`
- `0 <= overlap_sec <= min(budget_sec, performance_action_sec)`
- `budget_sec + performance_action_sec - overlap_sec <= duration_sec`
- `concurrency: sequential` 时 `overlap_sec = 0`
- `concurrency: partial_overlap` 时 `0 < overlap_sec < min(budget_sec, performance_action_sec)`
- `concurrency: full_overlap` 时 `overlap_sec = min(budget_sec, performance_action_sec)`
- `partial_overlap / full_overlap` 仅在 `budget_sec > 0` 且 `performance_action_sec > 0` 时成立；任一分量为 0 时只能使用 `sequential`

语速优先取本项目演员、配音或 TTS 样本；没有样本时将 `estimate_basis` 标为 `unverified_readthrough` 并列入 timing 复核，不能套用统一汉字/秒。无台词镜头将 `budget_sec / estimated_speech_sec / pause_sec / overlap_sec` 填 0，`concurrency` 填 `sequential`，`estimate_basis` 填 `not_applicable`。动作状态继续使用现有 `planned_start_state / video_plan.subject_motion / planned_end_state`，声音只使用 `audio_text.sound_design.layers[]`，不创建重复协议。

锁版对白和旁白始终保留在 `audio_text.dialogue / narration`。先尝试在单元真实总时长内调整镜头分配或跨镜承接口播；仍装不下时，保留原稿实测 `speech_budget`，置 `timing_status: blocked`，在 `timing_blocker` 写明失败公式和实测值，并停止 Shot Card finalization。确需建议删改时，只在对应 `proposed_dialogue_change / proposed_narration_change` 中记录 `status: proposed`、原因、候选文本和独立 `candidate_timing`；不得用提案覆盖、置空或改写原字段，候选 timing 可行也不能把当前锁版卡改成 `ready`。剧本 owner 批准候选文本并产生新的锁版版本后，更新 `source_evidence`、重新测算 canonical `speech_budget`，通过公式才生成新的 `ready` Shot Card。输入未锁版且用户明确授权改稿时，才可直接修改。

锁版原文超时的阻塞交接使用下列结构；旁白提案沿用同一 `candidate_timing` 结构：

```yaml
audio_text:
  dialogue: "【林若霜】原样保留的锁版长对白"
  narration: null
  timing_status: "blocked"
  timing_blocker:
    code: "source_timing_overflow"
    failed_rule: "budget_sec + performance_action_sec - overlap_sec <= duration_sec"
    duration_sec: 3.0
    measured_total_sec: 3.8
  speech_budget:
    budget_sec: 3.8
    estimated_speech_sec: 3.4
    pause_sec: 0.4
    performance_action_sec: 0.8
    concurrency: "full_overlap"
    overlap_sec: 0.8
    estimate_basis: "project_voice_sample"
  proposed_dialogue_change:
    status: "proposed"
    reason: "source_timing_overflow"
    candidate_text: "【林若霜】候选短对白"
    decision_owner: "script_owner"
    candidate_timing:
      status: "ready"
      speech_budget:
        budget_sec: 2.3
        estimated_speech_sec: 2.0
        pause_sec: 0.3
        performance_action_sec: 0.8
        concurrency: "full_overlap"
        overlap_sec: 0.8
        estimate_basis: "project_voice_sample"
  proposed_narration_change: null
```

---

## 三、景别标准表

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

## 四、机位角度表

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

## 五、对话/旁白/音效写作规范

### 对话字段规范

```yaml
# 格式：角色名 + 表演指示 + 锁版台词
dialogue: "【林若霜】（声音微颤，目光不离面具）\n这面具……不是赝品。"
```

**规则：**
- 台词数量服从本镜 `speech_budget`，不能用固定句数代替真实口播测算
- 必须标注表演指示（语气/节奏/气息）
- 锁版输入中的对白必须原样保留；若超时、冗余或功能不足，保留 `source_evidence` 并输出 `proposed_dialogue_change` 交剧本 owner，不在拆镜阶段直接删除/改写
- 只有输入未锁版且用户明确授权改稿时，才可删除无功能对话
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
- 锁版输入中的旁白必须原样保留；画面可替代、超时或重复时只输出 `proposed_narration_change`，交剧本 owner 裁决
- 只有输入未锁版且用户明确授权改稿时，才应用“能用画面表达就不用旁白”和“旁白只提供画面无法传达的信息（时间跳跃/内心/反讽）”
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

## 六、真实时长单元拆镜规则（常见 15 秒）

### 宫格数量选择

| 宫格数 | 适用场景 | 15 秒单元的参考平均 |
|--------|----------|-------------|
| 2 格 | 对话正反打、对比蒙太奇 | 7.5s |
| 3 格 | 起承转（建立→发展→转折） | 5s |
| 4 格 | 标准叙事段落 | 3.75s |
| 5 格 | 快节奏动作/追逐 | 3s |
| 6 格 | 极快剪辑/蒙太奇/时间流逝 | 2.5s |

上述平均值只用于初排，不授权其他技能另设格数默认。最终必须满足：

- 各格时长之和严格等于单元真实时长
- 每格只承担一个主要可见变化
- 静态画面、后续视频运动、声音和本地文字分别记录
- raw 不烧录字幕、格号、水印或信息栏；labeled/宫格信息由本地排版
- 2–6 格不足以承载剧情时拆成下一单元，不强塞第 7 格

### 拆镜检查清单

- [ ] 景别是否有变化？（禁止连续 3 格相同景别）
- [ ] 运镜是否有动机？（无动机运镜 → 改为固定）
- [ ] 口播预算是否有估算依据，`overlap_sec` 是否有真实表演依据，台词、停顿和动作是否装得进本镜真实时长？
- [ ] 每格是否有明确叙事功能？（建立/推进/转折/高潮/收束）
- [ ] 连续性锚点是否完整？（服装/道具/空间/光线）
- [ ] 多镜头单元是否有 `spatial_rule_ref`；单镜头无规则时是否只写局部空间；若越轴，是否用重建空间镜头或新规则显式说明？
- [ ] 情绪是否有递进？（禁止 6 格同一情绪强度）
- [ ] 每格是否能画成一个静态终态，而不是动作流程或多时刻拼贴？
- [ ] 原文证据与新增提案是否分开，是否误把 `proposed` 写成 canon？
- [ ] 各格时长之和是否精确等于项目真实单元时长？
- [ ] Shot Card 是否只保存 `observed_end_state_ref`，且该引用只指向已通过原尺寸审片的唯一观测记录？

---

## 七、交付序列化

第二节的 `shot_card` YAML 是唯一规范模板。交付时逐镜输出该结构的 YAML/JSON；若同时提供 Markdown 表格或界面视图，只能由同一对象无损渲染，不得手写第二份字段表、改名、合并或省略叶字段。

至少保持五个字段组 `identity / static_frame / video_plan / audio_text / continuity_anchor` 的原始层级（五组缺一不可），并保留每个叶字段的规范路径。`timing_status: blocked` 时仍序列化原稿 `speech_budget`、`timing_blocker` 和 proposal 内独立 `candidate_timing`；它是阻塞交接，不是可执行成片卡。

---

## 八、与下游的接口

| 下游消费者 | 需要的字段 |
|-----------|-----------|
| `ai-drama-production-prompts` | `static_frame` + 锁 + 引用角色 → 组装单格 imagegen prompt |
| `cinematic-camera-movement` | camera_movement 字段 → 运镜提示词 |
| `facial-expression-system` | facial_expression + expression_detail → 表情提示词 |
| `ai-drama-continuity` / `studio-continuity` | `shot_id`、计划状态与 `observed_end_state_ref` → 连续性索引/九字段 |
| `studio-generation` | shot_id + unit_id → 冻结包关联 |

---

## 九、明确不做

- 不直接生成 imagegen prompt（由生产提示词 Skill 负责）
- 不绕过 BindingSet 消歧
- 不在 Shot Card 中写入模型参数（temperature/steps/cfg）
- 不把多格排版/字幕/水印写进单格描述
- 不把计划终态写成已观测终态，不把未审图当尾帧，不在 Shot Card 复制观测 payload
- 不为凑足 15 秒或固定格数改写锁版剧情
- 不为动作三态、声音分层或空间状态建立与既有 owner 平行的第二套字段
- 不替代导演审美判断——本 Skill 提供结构，创意选择归用户
