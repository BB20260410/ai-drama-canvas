---
name: managed-studio-agent-loop
description: 受管 Studio 标准环「活动工程→读锁→生图→原子写回→审」。Grok/Codex 经 MCP 连同一工程时使用；不查库、不每轮粘贴路径或全书。
---

# 受管 Studio · Agent 标准环

用户在桌面看片/整理/审片；你通过 MCP 读写**同一** `projectRoot` / `projectId`。

**Goal 北星**：画布不是旁路工具箱，而是对 Grok/Codex 生图的 **角色/场景/站位等一致性关键辅助**；生图与画布完善双轨并行，见 `docs/GOAL_双轨_生图与画布互补契合.md`。写命令 require 写租约。formal PASS ≠ 产品 100% 契合。

## 短环（默认照做）

1. **验** `get_capabilities` → 构建身份允许后继续
2. **连** 零参数 `get_active_managed_studio_context` → 记下 `project.id` 与 `projectContextToken`；禁止偷选项目列表第一项
3. **读** `get_studio_production_dashboard`（overview / units / assets / queue）与 `get_studio_generation_control(readiness)`  
   → 软件给出已锁人物/场景/道具与提示词；歧义则停，请用户确认
4. **冻/派** 只走 `execute_command`，带 revision/idempotency key，并显式 `provider: grok`
5. **生** 只按 pack 内权威 SHA、冻结提示词和最多六项允许参考生图
6. **写** `commit_agent_imagegen_result_bundle`，带 token/pack/run/provider/raw 路径/执行回执；由软件导入并本地产生 labeled
7. **审** 写回后仍是 pending Review；机械通过不等于视觉通过

## 禁止

- 打开 SQLite/CAS 当操作面  
- 偷选第一候选绑定  
- 浏览器/Artlist/ComfyUI 默认生图绕过合同
- 读取、保存或回显 API 密钥
- 把机械 pass 当视觉通过  

## 对应 MCP Prompt

`managed_studio_lock_generate_writeback` — 连接后 list prompts 即可拉起本环，无需粘贴本文。
