# Nano Banana 宫格适配层

## 边界

仅在用户明确指定 Nano Banana，或当前调用 surface 已确认使用该模型族时加载。此文件只编译文案和结构，不证明模型可用、不调用外部服务，也不把模型名、价格、分辨率、引用数量或参数写成 Core 真理。

先读取 `coverage-board-3x3.md` 判定 `coverage_board`、`narrative_storyboard` 或 `character_reference`，再做适配。

## 运行前参数

从当前调用现场取得并记录：

- `provider_surface`
- `model_variant`
- `board_mode`
- `layout`
- `cell_aspect_ratio`
- `render_mode`
- 参考图实际上传顺序、职责和 SHA

横屏与竖屏共用一个适配器，通过 `cell_aspect_ratio: 16:9 | 9:16` 切换。NxN 方阵的整体画幅与单格画幅相同；非方阵必须重新计算，不凭文件名猜比例。

## 结构化输出

输出必须是可解析 JSON，不使用注释、尾逗号或省略号。模型参数放在 prompt 外。
以下 JSON 只示意单个 shot 的字段形状；实际 `layout=3x3` 时，`shots` 必须精确包含 9 个对象。

```json
{
  "adapter": "nano-banana-grid/v1",
  "provider_surface": "runtime-supplied",
  "model_variant": "runtime-supplied",
  "board_mode": "coverage_board",
  "layout": "3x3",
  "shot_count": 9,
  "cell_aspect_ratio": "16:9",
  "render_mode": "individual_raw_then_local_compose",
  "reference_registry": [],
  "shots": [
    {
      "shot_id": "COV-01",
      "beat_id": null,
      "duration_s": null,
      "frame": "",
      "angle": "",
      "composition": "",
      "action": "",
      "camera_movement_reason": "",
      "lighting": "",
      "identity_refs": [],
      "planned_start_state": {},
      "planned_end_state": {},
      "prompt_text": "",
      "negative_constraints": []
    }
  ]
}
```

`coverage_board` 可将 `beat_id` 和 `duration_s` 设为 `null`；`narrative_storyboard` 必须填写。不要设置任意“至少 50 个英文词”门槛，以清楚、无冲突、可生成作为标准。

## Prompt 编译

正式逐格 raw：

- 一次只编译一个 shot，重复当前 shot 所需的完整身份和连续性块。
- 用参考图承担身份、场景拓扑和已批准状态；文本只写本镜变化、机位、光线和终点。
- 禁止图内编号、字幕、时间码、水印、UI、多宫格、重复人物、跨格元素和混合肢体。
- 静帧提示词描述构图和动作瞬间；运镜及其理由保留在 Shot Card 或视频提示词中，不伪装成已发生运动。

快速 composite preview：

- 只使用已确认的九格描述和统一风格块。
- 明确 3 行 3 列、阅读顺序、细边框、格间留白、严格格间隔离。
- 不要求模型渲染中文编号；编号在本地合成。
- 标记 `canonical_eligible=false`，不得作为下一镜 continuation source。

## 参考职责

每项引用必须标明 `canonical_identity`、`continuation_source`、`composition_hint` 或 `forbidden`。适配层按实际上传顺序保留标签，不自行重排；身份冲突、素材未审或 SHA 不一致时停止编译。

## 失败处理

- 格数错误、串格、主体融合、重复脸或跨边框：切换为逐格 raw，不连续盲抽整张 composite。
- 单格身份漂移：只重做该格，并重新锚定批准的 canonical identity。
- 比例、模型或引用能力不明确：标记 `surface_capability_unverified`，不猜参数。
- 提交状态或计费结果不明：先对账，不重复提交。

## 验收

- 横竖屏仅由参数切换，没有两份重复模板。
- JSON 可解析，九个 shot 对象真实存在，不以省略号代替。
- 正式输出没有图内文字，多格板来自本地排版。
- 每个引用有职责，未知字段和未批准视觉提案没有进入硬锁。
- 适配完成与真实生成、机械 QC、视觉验收分别报告。
