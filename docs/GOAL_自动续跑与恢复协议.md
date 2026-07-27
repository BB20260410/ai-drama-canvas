# Goal 自动续跑与恢复协议（硬基础设施 + 执行纪律）

> 目标：`/goal` 交代任务后**持续执行到完成**；中途停也能**自动恢复**。  
> 进度唯一真相源：**磁盘 `STATUS.md` / `TASKS.md`**。

## 北星（无限画布 × Grok 模式 · 2026-07-23）

**权威全文：`docs/GOAL_双轨_生图与画布互补契合.md`。**

在本项目跑 `/goal` / 续跑时，默认双轨并行，不得只刷产线绿：

1. **A 轨 · 生图** — 按剧本真实出图（隔离工程；provider 以 STATUS 为准）  
2. **B 轨 · 画布辅助** — 把无限画布做成对 Grok/Codex 生图的关键辅助：  
   **角色一致性、场景一致性、站位/构图一致性**，以及道具/光色/风格/节拍等未点名但同级的一致性  

**终局：** 画布与 Grok/Codex **互补到高契合**——代理主要靠画布合同完成剧本生图，而不是旁路另起事实源。  
**剧本产品环（owner 增补）：** 存放/阅读剧本、一键剧本↔图对照、15 秒分镜设计 — 计划 `docs/GOAL_剧本库与15秒分镜产品计划_20260723.md`。  
**壳层/工程化（Qwen 裁决，Goal 任务内）：** `docs/GOAL_Qwen建议多代理裁决与长期任务_20260724.md` — Phase A–G 为可调度 TASKS；**不**整包照搬六阶段；工程化 **不得** 打断 A formal。  
**禁句：** 有序链 formal PASS ≠「与无限画布产品 100% 完美契合」。切片未齐不得 `completed`。

每轮：先做 STATUS earliest（A）；本步暴露画布缺口则同会话修 B；B earliest 可含 SSL **或** Qwen Phase D/E 壳层项；再回 earliest。
---

## 为何会「看起来 goal 停了」（机制事实）

| 层 | 事实 |
|----|------|
| Goal 本身 | **不是**无人值守守护进程；回合结束即停，靠下一轮用户消息 / 钩子续跑 / scheduler 唤醒 |
| 模型行为 | 切片完成后误 `update_goal(completed)`，或回合末只写「下一步」不起工具 → **假停** |
| 上下文 | ~85% **auto-compact** 会丢旧对话；**不丢磁盘 STATUS** |
| 系统硬顶 | Stop 钩子每回合最多续 **8** 次，之后本回合强制结束 → 必须靠 **跨回合 scheduler** |

**不是 goal 开关坏了**，是：缺「停前闸」+「跨回合唤醒」时，模型一旦停工具就会闲置。

---

## 已落地的硬基础设施（2026-07-23）

### 1. Stop 闸（同回合强制续跑）

- 脚本：`~/.grok/bin/goal-stop-continue.sh`
- 注册：`~/.grok/hooks/goal-continue-stop.json`（全局，无需 project trust）
- 行为：`reason=end_turn` 且 `STATUS.md` 仍显示进行中 / 有 earliest 下一步 →  
  **`decision: block`**，把「立刻用工具做 STATUS 下一步」塞回模型  
- 放行：STATUS 已关账、无 STATUS、或明确「等待 owner / 红线需用户」

> 新会话需已加载 hooks（`/hooks` 可查）。改 hooks 后开新会话最稳。

### 2. 持久 Scheduler（跨回合 / 跨会话唤醒）

- 由 agent 创建：`scheduler_create(interval="2m", durable=true, foreground=true, …)`
- 提示词模板：`scripts/goal-resume-prompt.txt`
- 行为：每 2 分钟读 STATUS 续跑；若已关账则空转退出
- 列表 / 取消：`scheduler_list` / `scheduler_delete`
- 最长存活约 **7 天**（Grok 平台上限），到期需重建
- **自检硬规则**：每轮开工若 `scheduler_list` 为空且 STATUS 仍 Goal 进行中 → **立即重建 scheduler**（2026-07-23 实况：U08 后列表变空导致假停）

### 3. PreCompact 提示

- 压缩前提醒：进度只信 STATUS；压缩后从 earliest 下一步续。

### 4. 磁盘协议

- 开工必有 `STATUS.md` + `TASKS.md`
- earliest 下一步 = **唯一续跑入口**
- 切片完成只更新进度 + `update_goal(message=…)`，**永不**整目标未完就 `completed`

---

## 执行纪律（模型）

1. **禁止**切片完成就 `update_goal(completed=true)`。  
2. **回合末禁止**只输出「下一步：…」；末段必须是工具调用或真结束。  
3. Skeptic / 修 bug 结束后**立刻**回 STATUS earliest。  
4. compact 后**只读磁盘**，不假设旧对话还在。  
5. 真阻塞（只有用户能给）→ 写 STATUS「阻塞」+ 需要什么 → 才可停。

---

## 开工自检

```bash
head -80 STATUS.md && cat TASKS.md
# hooks
ls ~/.grok/hooks/goal-continue-stop.json ~/.grok/bin/goal-stop-continue.sh
# scheduler（应有 durable goal-resume）
# 在 agent 内 scheduler_list
```

---

## 完成门（整目标 · 对齐羁绊 L5）

**热路径宪法**：`scripts/goal-resume-prompt.txt`（2026-07-23 v2 优化）。  
**Stop 假关账拦截**：DONE 文案子串且 `dual_track_gate` 未全真 → 仍 block（`goal_continue_lib.dual_track_gate_all_true`）。

仅当 STATUS 可解析为全真才可 `completed`：

```
A_done=yes ∧ B_demo=yes ∧ SSL≥ssl3(+ssl4 或 waiver) ∧ crit_bugs=none ∧ fit_band=L5
```

并：TASKS 无未降级未勾项；证据索引非空；禁写工程未污染。  
formal 齐 / SSL-0 原型 / 自写 partial **不够**。

切片：只 `update_goal(message=…)` + 写盘。

### 每轮

严格 S0–S7（resume）；`b_skip_streak≥1` 先 B；`block_kind=owner_only` 才可真阻塞停。
---

## 本仓库当前续跑入口

见根目录 `STATUS.md` 的 **earliest 下一步**。  
长期计划：`docs/GOAL_生图画布羁绊_长期计划_20260723.md`  
剧本库 SSL：`docs/GOAL_剧本库与15秒分镜产品计划_20260723.md`  
**Qwen 裁决（壳层/工程化/前端，Goal 内）：** `docs/GOAL_Qwen建议多代理裁决与长期任务_20260724.md`  
首轮提示词：`docs/GOAL_羁绊首轮执行提示词.md`  
隔离工程：`projects/dudu-gaiden-lock-20260723-12a6516c`  
禁止写：`codex-ai-drama-studio` / `dudu-s1e1-*` PASS
