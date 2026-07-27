# 第三方 Effect / Transition OTIO 有界兼容验证报告

验证时间：2026-07-14 15:45（Asia/Shanghai）  
工作区：`/Users/hxx/Documents/无限画布`

## 1. 优先级核验与结论

本轮开始时，`docs/当前开发交接.md` 所列“第三方 Effect / Transition OTIO 兼容核心纵向切片”仍成立：当时 `get_capabilities.editor.missingForFullNle` 仍包含 `third-party-effect-compatibility`，导入器会拒绝全部标准 Transition 和除 AI Canvas 私有字段外的 Effect，FFmpeg、MCP 与 Electron 也没有可证明的第三方标准对象闭环。本轮没有重写已经验证的复杂嵌套 resolver、关键帧、ComfyUI、HTTP 对账或发布状态机。

该优先级现已完成，且结论严格限定为一个失败关闭的标准 allowlist：

- active `LinearTimeWarp.1`，`effect_name="LinearTimeWarp"`，`time_scalar` 0.1–8，仅普通本地视频/音频；
- active `Transition.1/SMPTE_Dissolve`，仅最低 order 主视觉轨的相邻普通视频，正整数帧 in/out offsets；
- 其余通用 `Effect.1`、裸 `TimeEffect`、`FreezeFrame`、自定义 transition type、opaque metadata、disabled 对象、marker 和不受支持组合继续明确拒绝；
- AI Canvas 既有 `fade` 仍是淡到/淡出项目背景，不冒充标准 cross dissolve。

`get_capabilities.editor.missingForFullNle` 现在只剩 `real-project-nle-validation`。该下一优先级需要正式 AI 漫剧项目导入/校准授权，本轮没有获得，未执行。

## 2. 标准依据与核心合同

实现以 OpenTimelineIO 0.19.0 对应的固定官方源码提交 `2f3e0a433f22fc92b5341e71893c68b80b2ff935` 为依据：

- [OTIO serialized schema](https://github.com/AcademySoftwareFoundation/OpenTimelineIO/blob/2f3e0a433f22fc92b5341e71893c68b80b2ff935/docs/tutorials/otio-serialized-schema.md#L312-L673)；
- [Transition 定义](https://github.com/AcademySoftwareFoundation/OpenTimelineIO/blob/2f3e0a433f22fc92b5341e71893c68b80b2ff935/src/opentimelineio/transition.h#L10-L101)；
- [Timeline / Transition 时域说明](https://github.com/AcademySoftwareFoundation/OpenTimelineIO/blob/2f3e0a433f22fc92b5341e71893c68b80b2ff935/docs/tutorials/otio-timeline-structure.md#L89-L122)；
- [LinearTimeWarp 定义](https://github.com/AcademySoftwareFoundation/OpenTimelineIO/blob/2f3e0a433f22fc92b5341e71893c68b80b2ff935/src/opentimelineio/linearTimeWarp.h#L10-L52)。

### 2.1 可证明媒体范围

- `EditClip.sourceAvailableRange` 保存整数帧可用范围；v1 只接受 `startFrame=0`，避免把 FFprobe 无法独立证明的任意非零范围当成真实句柄。
- OTIO 导入在任何工程/history 文件写入前，对参与 TimeWarp/Dissolve 的每个绝对本地路径执行 FFprobe；声明结束帧超过实际时长即失败，不留下空工程。
- TimeWarp 的 source range 必须按 scalar 无损换算为整数输出帧，并落在 verified available range 内。
- Dissolve 的 incoming pre-roll、outgoing post-roll、相邻可见时长和同一片段两端 transition 不重叠都按整数帧校验。

### 2.2 身份、往返与编辑

- 根 metadata 使用 `aicanvas.otio-effect-transition.v1`；内部 structured transition 使用 `aicanvas.otio-transition.v1` 和目标 clip ID，避免只保存一个易漂移的名称或秒数。
- OTIO export 写标准 `LinearTimeWarp.1` 和 `Transition.1/SMPTE_Dissolve`；reimport 交叉验证标准对象与私有身份，未知/冲突字段拒绝。
- `split_clip` 把 outgoing transition 身份移动到右片段并保持目标 ID；会破坏邻接或 handle 的 move/trim 失败关闭；undo/redo 使用既有持久快照。
- TimeWarp 与 Dissolve、transform keyframes、fade envelope 的首版组合明确拒绝，不建立第二 Effect 状态机。

### 2.3 渲染消费者

- TimeWarp 的视频 PTS 与音频 atempo 复用既有 FFmpeg 链。
- Dissolve 为 outgoing 加 post-roll、incoming 加 pre-roll，再按项目有理时基构造 xfade；transition 不改变主轨总时长。
- 同步成片、后台成片、时间线抽帧和 Continuation 共用同一渲染合同；首版 Dissolve 只改变视觉，独立 audio track 时域不变。

## 3. 真实媒体永久证据

永久入口：

```bash
npm run editor:effect-transition-render-smoke
```

隔离 fixture 使用 24000/1001 H.264 红/蓝视频、48kHz WAV、非对称 5/7 帧 SMPTE Dissolve 和 2x LinearTimeWarp：

- 同步与后台成片均为 48 帧、31638 bytes，SHA-256 都是 `c1b76e3d3ae6cf4f7dd156079a63e476830c0c325062f2598e670714f26b8457`；
- F18 红均值 253.75 / 蓝 0.07，F24 红 146.00 / 蓝 103.81，F28 红 62.94 / 蓝 189.90，F31 红 0.09 / 蓝 254.74，权重单调并存在两路同时贡献；
- 2x 音频 stream 为 1.001 秒；
- 合成中间帧 `effect-transition-midpoint-20260714.png` 为 320×320，红/蓝均有贡献；
- fresh Node 进程生成 timeline continuation，末帧为蓝场，`sourceType=timeline`、`generationJob=null`、`enqueue=false`，没有远端提交或上传。

结构化证据：`docs/evidence/effect-transition-render-smoke-20260714.json`，SHA-256 `ef0d853955c948c0119bd241cff30062f3ab8914ff2e46891c7955a219958ecd`。

## 4. Electron 真实交互与视觉验收

永久入口：

```bash
npm run ui:editor-effect-transition-smoke
```

当前 production Electron build 在隔离真实 H.264 fixture 中完成：

- Inspector 初始读取标准 `smpte_dissolve` 与 3/5 帧 offsets；参与片段的 playback rate 和新增 transform keyframe 控件禁用；
- 播放头位于切点时，同时存在 outgoing/incoming 两个真实 video 元素，currentTime 为 1.167/0.167 秒，opacity 为 0.625/0.375，两路均静音，独立音轨不受影响；
- offsets 改为 2/4 后保存 r2、撤销 r3 恢复 3/5、重做 r4 恢复 2/4；标准 OTIO 导出保持 `Transition.1/SMPTE_Dissolve`；
- 关闭整个应用并启动全新实例后仍为 r4、2/4，双流 currentTime/opacity 与预期一致，page errors 为 0；
- fixture root 和 registry 已清理。

主代理已实际查看 `docs/evidence/editor-effect-transition-ui-20260714.png`：1560×980、254543 bytes，SHA-256 `c7517d2dce0bb92711d788b5f817fdb68e748e9c71b9b0ec0698692cb62e7c32`。中心预览明确显示红蓝交叉混色和两侧色块，右侧 Inspector 清晰显示 SMPTE Dissolve、2/4 帧 offsets，无黑屏、空白、占位或控件遮挡。

结构化 UI 证据：`docs/evidence/editor-effect-transition-ui-smoke-20260714.json`，SHA-256 `e4a204820e9456802ff501060379a0b3b0fbe6671b7c44766df4290c66507233`。

## 5. MCP、Capabilities 与自动门禁

- MCP 不新增旁路工具；继续使用 `apply_edit_operation(update_clip)`、`execute_command`、revision CAS 和幂等账本。
- source server 与 `dist-mcp/mcp/server.js` 都通过真实媒体 OTIO 导入、offset 修改、幂等重放、stale CAS、fractional offset schema 拒绝和标准导出。
- `get_capabilities.editor.effectTransitions` 公开 allowlist、组合限制、渲染消费者、UI、MCP 和失败关闭策略；工具总数保持 134。

| 门禁 | 结果 |
| --- | --- |
| 核心 Effect/Transition 专项 | 5/5 通过 |
| MCP source 专项 | 1/1 通过 |
| MCP compiled 专项 | 1/1 通过 |
| Capabilities/Codex/MCP 回归 | 3 文件，10/10 通过 |
| 全量测试 | 38 文件，216/216 通过，121.72s |
| MCP smoke | 134 tools、9 Resource Templates、7 Prompts |
| production build | typecheck、main、preload、renderer、MCP 全部通过 |
| MCP headless | 22 ledger、0 uncertain、Doctor 0 error/0 warning、runtime idle |
| MCP real（完整隔离根，只读） | Doctor 0 error/0 warning、active 0 |
| MCP empty-project | 19 ledger、0 uncertain、restart verified |
| full workflow | 成片、续接、导出与 fresh-process restart verified |

最终构建体积：

- `out/main/index.js`：943952 bytes；
- `out/preload/index.mjs`：17526 bytes；
- renderer JS：1300411 bytes；
- `dist-mcp/mcp/server.js`：185760 bytes。

## 6. 关键文件哈希

| 文件 | SHA-256 |
| --- | --- |
| `package.json` | `b0a95580c970abf62a2f8f36d42a4a503eb65af7b47d1b0dbf4d74eec7cbfab0` |
| `src/core/types.ts` | `c6901f66ba18f3145115cdf8dc4a24ff8d347b034f5eb42a13d2637361ac9c04` |
| `src/core/editor.ts` | `f6d75f2d4c7c7b51adc1c5489158ad100ad9c6f55850b24d317545aa144b97a8` |
| `src/core/codex.ts` | `989aef1f171d23fa92c43ce1a26640a971fb4ba87919d29e22b1298586feee47` |
| `src/mcp/server.ts` | `4a5d18e172effb4d81d65f6346a29443adc2c94713b0d223824018fc493aa03b` |
| `VideoEditorView.vue` | `37d26d9481b1e5917d6ecd9a19c402b1ae39e14d8f64cd53f2d30e190a3885b3` |
| `tests/editor-effect-transition.test.ts` | `763ca46b188d18bc3215c017677a86dd44161b96fef457c5090ac4377c372761` |
| `tests/mcp-editor-effect-transition.test.ts` | `80d097a735bd5b8e7585e2f24bd3131f63ffde04f773825ce97b66bd406e57f0` |
| `scripts/effect-transition-render-smoke.ts` | `a1077170c8bba9dad234a324571181fce5afdbf9af4b7155305035b57c3f80ab` |
| `scripts/ui-editor-effect-transition-smoke.mjs` | `a6a584c6cd6381e6c47cf980bc84f99ecc736d746908f76fd1b66059b46564ca` |

## 7. 授权边界与既有产物

- 未扫描、导入或修改正式 AI 漫剧项目；未触碰工作区外创作素材。
- 未连接真实 ComfyUI、Provider 或生成网站；无登录、上传、付费、发布、公证、安装、git commit、push 或 PR。
- 续接验证明确 `enqueue=false`；headless/full 只使用本地 `/tmp` fixture 和本地文件桥接，不产生外部副作用。
- 已签名 DMG 未覆盖：136652595 bytes，SHA-256 `ee7c78f16104b3881650353052669fa60c8fd4deb196cc5f49a2f1c765a20972`，mtime 仍为 2026-07-14 01:08:10 +0800。它仍是旧源码快照且未公证。
- Git 仍为无提交 `main`，整个项目未跟踪；没有 stage、commit、push 或 PR。

## 8. 已知限制

- 这是标准 OTIO 的有界子集，不是任意插件、任意 Effect、任意 transition 或通用 NLE 工程兼容。
- v1 只接受 `sourceAvailableRange.startFrame=0` 且本地 FFprobe 可证明的绝对路径媒体。
- SMPTE Dissolve 只支持主视觉轨相邻普通视频；不与 TimeWarp、transform keyframe 或 fade envelope 组合；独立音频轨不随视觉 dissolve 交叉混音。
- `FreezeFrame`、generic `Effect.1`、自定义 Transition、disabled/opaque 对象和 marker 继续失败关闭。
- 正式项目 NLE 校准、真实 ComfyUI/Provider/网站和 Apple 公证未获本轮授权，均未执行。

## 9. 下一唯一最高优先级

`get_capabilities.editor.missingForFullNle` 只剩 `real-project-nle-validation`。因此下一唯一最高优先级是“正式 AI 漫剧项目 NLE 校准”：在用户明确授权的项目副本/只读源边界内，导入真实长时间线和媒体，核对 source ranges、轨道、音频、标准 Effect/Transition、渲染、抽帧、Continuation、Electron 和往返差异，并用新输出/新证据收口。

本轮没有正式项目授权，不能自行执行该项，也不能用隔离 fixture 冒充正式项目校准。长期目标保持 active。
