# Unit-Grid Brief 模板 v1

代理生图必须按这 7 槽执行。槽位由冻结包投影，**不是**另写一套提示词。

| 槽 | 来源 | 上限 |
|---|---|---|
| STYLE_LOCK | layout + 风格 controlRef | 画风一句 |
| IDENTITY_LOCK | 角色 controlRefs | 每角色 ≤3 张；身份句 ≤40 字 |
| SCENE_LOCK | 场景 controlRefs | 每场景 ≤3 张 |
| BEATS | 逐格 instruction | 2–6 格 |
| HARD_NEGS | `forbidden` + 格负向 | 去重 |
| DELTA_ONLY | continuationSource | 无续镜则为空 |
| OUTPUT_RULES | exactlyOneImage + 禁文字 | 固定 |

运行时对象：`buildStudioUnitGridAgentImagegenBrief(...).promptContract`  
注入说明：`docs/prompts/INJECTION.md`

## 样例 A · 日常（2 格）

- STYLE_LOCK：9:16 / photoreal cinematic
- IDENTITY_LOCK：青灯客 主体，≤3 张脸/服/全貌
- SCENE_LOCK：雨巷客栈
- BEATS：G1 中景固定停步 7.5s；G2 近景微推抬头 7.5s
- HARD_NEGS：字幕、水印、宫格编号
- DELTA_ONLY：空
- OUTPUT_RULES：一张竖屏 2 宫格整板

## 样例 B · 战斗（4 格）

- BEATS：G1 全景起势；G2 中景出拳；G3 近景命中；G4 中景收势。总和 ≈15s
- DELTA_ONLY：若续上一镜，只写动作/机位变化，不复述脸服景
