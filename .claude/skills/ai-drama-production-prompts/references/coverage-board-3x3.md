# 3x3 机位覆盖板与剧情分镜分流

## 先分类

生成前必须写明 `board_mode`：

- `coverage_board`：同一剧情时刻、同一动作状态的九种机位，用于导演找角度。
- `narrative_storyboard`：时间向前推进，每格发生新的可见变化。
- `character_reference`：中性背景下的人物身份、服装和结构参考。

三种模式不能混用。固定九种景别只适用于 `coverage_board`；15 秒正式剧情仍按内容使用 2–6 镜。

## Coverage 3x3 默认矩阵

| 位置 | 默认覆盖 | 任务 |
|---|---|---|
| 1 | 极远景 | 交代人物、威胁与环境尺度 |
| 2 | 全景 | 看清完整主体和空间位置 |
| 3 | 3/4 中远景 | 看清轮廓、姿态和主体关系 |
| 4 | 中景 | 呈现主要互动或动作 |
| 5 | 中近景 | 捕捉身体压力和情绪变化 |
| 6 | 近景 | 锁定面部、物体正面或关键反应 |
| 7 | 大特写 | 聚焦眼、手、伤口、纹理或剧情物件 |
| 8 | 低机位 | 强化压迫、威胁或力量关系 |
| 9 | 高机位 | 展示困境、布局或脆弱感 |

按主体调整矩阵。群像必须保持关系可读；物体不套用“膝上、胸上”等人物裁切。没有剧情作用的低机位或高机位可换成反打、主观镜头、过肩或空间关系镜头。

## 电影性检查

Coverage 板每格至少说明 `coverage_function`、主体关系、摄影机位置、视线落点和空间方向。它不制造新事件。

Narrative 分镜每镜必须有：

- 当前剧情 beat 和发生的可见变化；
- 人物欲望、阻碍和空间几何；
- 环境压力、物理微动作、声音或视觉母题；
- 运镜理由、视线承接、时长和剪辑落点；
- 开始状态、计划终态及 `completed/current/reserved` 边界。

只有景别变化而没有剧情变化的九格，不得标为剧情故事板。

## 默认生产方式

1. 先输出镜头卡或结构化 JSON，确认九格职责。
2. 每格用同一 canonical identity、场景 Authority、光线和状态分别生成单张 raw。
3. 对每张原尺寸检查主体数量、身份、服装、道具、构图和可解码状态。
4. 只重做失败格，不整板无界重生。
5. 将已通过 raw 本地合成为 3x3 板，再添加编号、边框和中文说明。

正式 raw 的提示词必须排除多宫格、文字、字幕、水印、UI、跨画面元素、重复主体和混合肢体。

## 快速单图预览例外

只有用户明确要“快速概念预览”，且结果不进入正式资产链时，才允许模型一次生成 3x3 composite。必须标记：

```json
{
  "render_mode": "composite_preview",
  "review_status": "unapproved",
  "canonical_eligible": false,
  "continuation_source_eligible": false
}
```

预览提示词需声明三行三列、从左到右从上到下、细边框、格间留白、每格内容完全隔离、任何主体或肢体不得跨越边界。出现格数错误、串格、融体、重复脸或文字乱码时，停止整图重试，改为逐格 raw。

## 输出字段

以下 JSON 只示意单个 shot 的字段形状；实际 `layout=3x3` 时，`shots` 必须精确包含 9 个对象。

```json
{
  "board_mode": "coverage_board",
  "layout": "3x3",
  "shot_count": 9,
  "cell_aspect_ratio": "16:9",
  "render_mode": "individual_raw_then_local_compose",
  "shared_locks": [],
  "shots": [
    {
      "shot_id": "COV-01",
      "coverage_function": "establish_context",
      "frame": "extreme_long_shot",
      "camera_position": "",
      "subject_relationship": "",
      "eye_trace": "",
      "continuity_state": "",
      "prompt_text": "",
      "negative_constraints": []
    }
  ]
}
```

## 验收

- 已明确 board mode，没有把 coverage 冒充剧情，正式 15 秒单元也没有被强制扩成九镜。
- 不可见空间和侧背面没有被提升为 canon。
- 正式板来自已验收单格 raw，编号与文字由本地添加；每格都有独立职责、清晰主体和可读空间关系。
