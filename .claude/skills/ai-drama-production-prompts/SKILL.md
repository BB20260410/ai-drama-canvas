---
name: ai-drama-production-prompts
description: 为 AI 短剧内容生产做人物/角色提取、别名归一、非人实体登记、角色圣经、参考图、3x3 九宫格多角度覆盖、电影分镜、15 秒 2–6 宫格、Nano Banana 横竖屏适配、连续性锁与漂移 QA 时使用。优先读本仓库 community-research 与本地 short-drama/seedance 镜像。触发：人物提取、角色提取、人物设定板、三视图、九宫格、3x3、多角度、多机位、分镜提示词、角色一致性、连续性、Nano Banana、Seedance、宫格故事板、BindingSet 冻结输入。
---

# AI 短剧生产提示词（本仓库适配版）

## 权威顺序

1. 本软件身份链优先：`CanonicalAsset` ID → Authority 版本 → 媒体 SHA → 硬锁 → `AssetBindingSet` → P7 九字段 → 上一格 raw
2. 社区提示词只填充**文案层**，不能发明未绑定资产或静默消歧
3. 单张正式 raw：**禁止**画入多格表格、字幕、水印、乱码；宫格板由本地排版器合成

## 任务路由

先判定任务类型，再完整读取对应参考；不要把三类任务混写：

- 从小说、剧本或文案找人物、代称、系统、鬼怪或其他实体：读 `references/character-entity-extraction.md`
- 同一时刻做 3x3 九宫格、多景别、多角度或导演机位覆盖：读 `references/coverage-board-3x3.md`
- 按时间推进剧情：走 Shot Card / 15 秒 2–6 宫格，不把固定九景别当剧情
- 用户明确指定 Nano Banana 或目标 surface：先按任务类型拆镜，再读 `references/nano-banana-grid-adapter.md`；供应商未明确时不加载适配层

人物提取、`coverage_board`、`narrative_storyboard`、`character_reference` 必须显式区分；不得静默互换。

## 必读摘录

- `docs/community-research/prompts/bigprompthub-6step-short-drama.md`
- `docs/community-research/prompts/bigprompthub-character-consistency.md`
- `docs/community-research/vendors/visual-skills/video/SKILL.md` + `references/dramaturgy.md`
- `docs/community-research/vendors/video-prompting-skill/video-prompting/references/workflows/character-sheets.md`
- `docs/community-research/local-mirrors/seedance-storyboard-generator/SKILL.md`（15 秒时间轴）
- `docs/community-research/local-mirrors/short-drama/SKILL.md`（微短剧节奏/钩子）
- `docs/community-research/Seedance2双仓选择性吸收与Studio映射_20260723.md`（连续视频状态、引用职责、重锚）

## 推荐生产链

```text
概念/剧本
→ 人物实体账本（原文证据 / unknown / 视觉提案分离）
→ 角色/场景/道具圣经（locked vs scene-changeable 分离）
→ 参考静帧包（三视图/正打反打/道具白底）
→ 人工确认 BindingSet（ambiguous 不得自动选）
→ 15s 单元 2–6 宫格拆镜（景别/运镜/动作/台词/时长）
→ 逐格 continuity sheet（九字段 + 可变项）
→ 单格 imagegen pack（冻结引用闭包）
→ Review / drift QA / 每 6 槽 checkpoint
→ 下一格引用已验收 raw
```

## 单格生图 pack 必须携带

- 规范资产 ID 列表 + Authority 版本 + SHA
- 正锁 / 禁项
- 连续性状态（或 unresolved）
- 上一格 raw 引用（若相邻且已 pass）
- 中文/英文 prompt 分离：展示用中文板 vs 模型 prompt
- 负向：多宫格排版、字幕烧录、水印、文字乱码

## 戏剧学最低检查（来自 visual-skills）

每个镜头要有：

1. 环境压力（空间如何压迫人物）
2. 可拍的物理微动作（禁止“意识到/感到”）
3. 声音或视觉母题

景别连续重复、无动机运镜、对白塞满 15 秒 → 重写。

## 输出默认

- 先给**可直接复制**的提示词，再附冻结字段表
- 多镜头时每个 clip 自带完整身份块（U7 连续性重复）
- 明确“模型参数在 prompt 外”
- 只有原文明确事实或人工批准项可进入硬锁；推断必须保留为 `proposed` / `unresolved`
- 九宫格编号、字幕和信息栏由本地排版器添加，不要求图像模型写字

## Seedance 连续视频编译

当任务涉及 I2V、续作、延长、尾帧接力或跨片段一致性时：

1. 先从既有 Studio owner 取得 CanonicalAsset Authority、媒体 SHA、BindingSet、九字段连续性和 Review head；不得从聊天或文件名猜身份。
2. canonical reference 只控制身份、场景拓扑和道具结构；已验收 previous clip / last frame 只控制实际开场站位、姿态、运动、摄影机、焦点、声音和环境排列。
3. 引用标签按实际上传顺序逐字保留，必须逐项声明 `transfer` 与 `ignore`；标签、媒体类型、职责或 SHA 不一致时停止。
4. 续作必须使用已验收结果的 `observedEndState`，不能用上一段的 `plannedEndState` 冒充真实末态。
5. 遵守“来源携带状态，文本只携带变化”：续作 prompt 不重复描述来源已经可见的开场，只写当前动作、机位、光线、声音与终点。
6. `completed / current / reserved` 三组事件 ID 必须互斥；当前片段只执行 current，已完成事件不得重演，未来事件不得提前出现。
7. `extensionDepth` 从场景合同读取；缺省建议 2，硬上限 3。超过上限或提前出现可见漂移时，显式停用旧输出，以 Authority 做有意切镜重锚，深度归零。
8. 产品链统一调用 `compileStudioSeedancePrompt`；该函数只编译合同，不调用模型。真实视频调用、回执、quarantine、Review 和结果写回仍必须走受管 Studio。

## 明确不做

- 不调用浏览器供应商
- 不在 P8–P10 研发期做正式 imagegen
- 不把社区 Seedance 多镜头 syntax、固定模型名、固定引用数或平台参数写进 Core 当真理源；Core 只保存调用现场提供的精确标签与受管身份
- 不把“系统/面板/空间”等概念自动拟人成实体，也不把模型补画的不可见侧背面提升为 canon
- 不因用户提到九宫格就把 15 秒正式剧情强制扩成九镜
