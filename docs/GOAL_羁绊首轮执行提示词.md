# /goal 首轮执行提示词 · 生图 × 无限画布羁绊

> 复制下方代码块全文，作为 `/goal` 首条消息。  
> 热路径宪法：`scripts/goal-resume-prompt.txt`（Stop / scheduler 亦指向它）。  
> **勿在代码块写死当前 U 号或 provider**——一律以 STATUS 为准。

```
/goal 长期执行「生图 × 无限画布羁绊成型」。

## 终局（必须真正理解）
一边用 Grok/Codex 按剧本真实生图，一边把无限画布做成关键辅助生产 OS：
角色/场景/站位/构图及道具·光色·风格·节拍等同级一致性。
剧本产品环：存放与阅读剧本、一键剧本↔图对照、15 秒分镜设计（接生图）。
终局=双轨互补高契合 + 功能可演示 + 关键路径无 BUG。
有序 formal PASS ≠ 产品 100% 完美契合。禁止空壳文档关账。禁止未 dual_track_gate 全真就 update_goal(completed)。

权威：docs/GOAL_双轨_生图与画布互补契合.md
计划：docs/GOAL_生图画布羁绊_长期计划_20260723.md（L0–L5）
剧本库：docs/GOAL_剧本库与15秒分镜产品计划_20260723.md（SSL-0…6）
工程化/壳层裁决：docs/GOAL_Qwen建议多代理裁决与长期任务_20260724.md（Phase A–G；改写采纳，禁整包照搬）
续跑宪法：scripts/goal-resume-prompt.txt + docs/GOAL_自动续跑与恢复协议.md
进度唯一真相：STATUS.md / TASKS.md（只信磁盘，不信本消息里的任何旧单元号）

## 双轨策略（每轮）
A 产线：隔离工程与 provider 均以 STATUS 为准；mcp-only + 写租约；真 gen→commit。
B 辅助：controlRefs/Binding/连续性/审片/一致性；卡点同会话修 B。
B 亦含 SSL（存·读·对照·15s）与 Qwen 裁决 Phase D/E（composable/虚拟列表/受闸快捷键/smoke 别名）——**永不压过 A formal**。
禁：Pinia 持 nextAction、拆 command-bus/ledger 写路径、插件市场、平行剧本库。
禁写：codex-ai-drama-studio / dudu-s1e1-* PASS。
授权内全自决；禁止可自动推进时向 owner 请示路线。

## 单元复盘闸（硬）
每 formal 一个 U 后：多代理复盘≥2 角 → 修 P0 → 验证无阻塞级 BUG → STATUS unit_retro=PASS 后才可 Un+1。
见 docs/GOAL_单元复盘闸门_20260723.md。禁止 formal 齐就连刷下一 U。

## 现在就做
1 读 STATUS/TASKS 的 A·B earliest、dual_track_gate、b_skip_streak、unit_retro
2 严格按 scripts/goal-resume-prompt.txt 的 S0–S7（含 S4b 复盘闸）用工具执行
3 做到无自动下一步或 STATUS 已记 block_kind=owner_only 为止；回合末禁止只输出清单
```
