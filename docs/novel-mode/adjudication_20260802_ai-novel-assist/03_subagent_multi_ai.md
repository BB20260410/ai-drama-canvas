# 03 · 多 AI 经同一受管小说工程协作（不抢写 · 不漂正典）

> 专席：多 AI 编排合同 · 只读分析  
> 日期：2026-08-02  
> 依据：`00_brief.md`、`AI_AGENT_CONTRACT_V1.md`、Writing OS V1 实现、`studio-project-write-lease`、`command-bus.novelWriteActor`  
> 范围：回答 brief **A / C / D / G / I**（多模型重点）  
> 非目标：改代码、重写 P0–P14 漫剧 owner、把聊天记忆升为正典

---

## A. 一句话结论

**多模型只能共用一个受管工程的单一真相源（正文 Markdown+manifest CAS + `story-bible/writing-state.json` CAS），经「角色化 MCP 权限 + 章级写租约/CAS + 候选不进正典」协作：任一模型最多写候选（正文 CAS 或状态 candidate / review ticket），正典推进只允许 `human_ui` / owner 裁决；禁止各 AI 自建记忆文件。**

---

## C. 目标架构（文字组件图）

### C.1 分层

```
┌─────────────────────────────────────────────────────────────────┐
│  Owner / 桌面 UI（human_ui）                                      │
│  · 活动工程登记  · 阅读/手改正文  · 状态候选 accept|reject          │
│  · 硬正典冲突裁决  · 释放/强制收租约  · 文学质量终审                  │
└───────────────────────────────▲─────────────────────────────────┘
                                │ novel_review_chapter_state_candidate
                                │ human_ui save（可无 preflight）
┌───────────────────────────────┴─────────────────────────────────┐
│  编排层 Orchestrator（默认 Grok；可 Claude 编排会话）              │
│  · 认工程 / 租约 / 章队列 / 角色派工 / 失败恢复 / 不写文学正文       │
│  · 唯一可调度：acquire/heartbeat/release lease + 读工具 + 结构命令  │
└───┬─────────────┬──────────────┬──────────────┬─────────────────┘
    │             │              │              │
    ▼             ▼              ▼              ▼
 主笔 Lead     结构审 Struct    声口 Voice     探针/去味 Probe
 千问 qwen     GLM             豆包           DeepSeek / Claude 只读审
 novel_save    review_ticket   不改正文*       review_ticket only
 + stage       可选 stage 草案  或 revise 窄写  不 stage 正典
 candidate
    │             │              │              │
    └──────┬──────┴──────┬───────┴──────┬───────┘
           ▼             ▼              ▼
┌──────────────────────────────────────────────────────────────────┐
│  无限画布 MCP / JSON CLI（aicanvas.novel-agent v1）               │
│  只读：workspace / list / range / search / writing_state / pack    │
│        / preflight                                                 │
│  写：execute_command → novel_*（账本 + CAS + 锁）                  │
│  身份：novelWriteActor=agent|human_ui（agent 强制 aiWriteContext） │
│  租约：acquire_studio_project_write_lease（建议扩至 novel 写命令）  │
└───────────────────────────────▲──────────────────────────────────┘
                                │
┌───────────────────────────────┴──────────────────────────────────┐
│  单一真相源（工程磁盘 · 禁止聊天记忆替代）                          │
│  manuscript/*.md + manifest          正文 CAS revision/sha256     │
│  story-bible/writing-state.json      状态 CAS revision/fingerprint│
│  .aicanvas/novel/writing-source-objects/sha256/  设定源不可变对象  │
│  .aicanvas/novel/change-sets/        状态候选（不可改正典）        │
│  .aicanvas/novel/change-set-decisions/ 人工裁决                   │
│  .aicanvas/novel/reviews/            审稿票（只读反馈）            │
│  .aicanvas/write-lease.json          项目写租约投影                │
│  命令账本 / studio-mutation 锁       幂等与并发                    │
└──────────────────────────────────────────────────────────────────┘
```

\*声口默认**不直接** `novel_save_chapter`；由编排收窄「仅对白/语气 delta」为 `revise_chapter` 任务，或只出 ticket 交给主笔/owner 合入。

### C.2 与现有实现的对齐点

| 组件 | 现状（源码合同） | 多 AI 用法 |
|---|---|---|
| 正文权威 | managed Markdown + manifest | 全模型只认此 CAS，不认各家会话笔记 |
| 状态权威 | `writing-state.json` 单文件 CAS | 八项/知情/关系/日历/伏笔只经 candidate→人工 commit |
| 写入口 | `execute_command` only | MCP/CLI/桌面都走同一 bus |
| Agent 写正文 | 空章 create → pack → preflight → `aiWriteContext` save | 主笔唯一默认写正文角色 |
| 人机写正文 | Main `novelWriteActor: "human_ui"` 可跳过 preflight | 仅桌面；AI 不得伪造此 actor |
| 审稿 | `novel_attach_review_ticket` 绑 SHA+UTF-16 区间 | 结构审/探针/多席并行只读票 |
| 状态 | `stage` 不改正典；`review_candidate` 人工 | 主笔可 stage；审稿可 stage 草案但默认不 commit |
| 写租约 | 当前硬闸主要在**生图**命令集 | 小说多代理应**同构扩展**到 novel 写命令（见 D） |
| 进程 | MCP singleton 防多主写 WAL | 一机一 MCP 主写；多模型经同一 daemon 串行账本 |

### C.3 数据流（单章接力，多模型）

```
1. Orchestrator
   get_active_managed_studio_context | explicit projectRoot
   get_novel_manuscript_workspace
   acquire_studio_project_write_lease(holderId=orchestrator-*, holderKind=agent|grok|codex)
   get_novel_writing_state(target, cutoff=before)
   若无空章 → novel_create_chapter(content 空)

2. Lead（主笔）
   build_novel_context_pack(taskType=continue_chapter|revise_chapter)
   preflight_novel_chapter_write(writePreflightInput 原样)
   模型在会话内生成正文（不落第二份「记忆稿」）
   execute_command novel_save_chapter + expectedRevision/Sha + aiWriteContext
   novel_stage_chapter_state_candidate（绑正文 CAS + state CAS）

3. Struct / Voice / Probe（并行只读，不抢 lease 写正文）
   build_novel_context_pack(taskType=review_chapter) → writePreflightInput=null
   read/search 取证
   novel_attach_review_ticket × N（各 reviewer 字段区分席位）
   （可选）结构席提交「状态差分建议」到候选旁路文件或第二 stage——见 G.4；V1 仅一人 stage

4. Owner / human_ui
   阅读正文 + tickets
   novel_review_chapter_state_candidate(accepted|rejected)
   需要改笔：指定 Lead revise_chapter 或桌面手改

5. Orchestrator
   确认 completion 已推进 → release lease → 下一章队列
```

**关键不变量：** 聊天 transcript、各 CLI 本地 cache、agent MEMORY.md **全部不是**正典；跨模型接力只读 pack/state/manuscript。

---

## G. 多 AI 协作协议（谁写 / 谁审 / 谁改状态）

### G.1 席位与模型映射（与 owner 多模型合同对齐）

| 席位 | 默认模型 | 工程内职责 | 允许的写副作用 | 禁止 |
|---|---|---|---|---|
| **编排 Orchestrator** | Grok（或 Claude 编排会话） | 认工程、租约、章序、派工、恢复、关账检查 | lease acquire/heartbeat/release；空章 create；结构类 rename/move（慎）；**不写章正文** | 文学正文、状态 commit、硬正典改写 |
| **主笔 Lead** | 千问 `qwen` | 唯一默认章正文生成 | `novel_save_chapter`（aiWriteContext）；`novel_stage_chapter_state_candidate` | 伪造 human_ui；跳过 preflight；多章并行 save |
| **结构审 Struct** | GLM | 情节/因果/时序/知情边界/禁揭机械审 | **仅** `novel_attach_review_ticket` | 改正文；accept 状态候选；seed 正典 |
| **声口 Voice** | 豆包 | 对白/语气/人称声纹 | 默认 **仅 ticket**；例外由编排签发窄 `revise_chapter` | 改设定卡；改知情；自由扩写情节 |
| **探针 / 去 AI 味 Probe** | DeepSeek | 文风探针、套话、节奏 | **仅** review ticket | 任何 CAS 写 |
| **交叉码/合同 Codex** | Codex | 工具链/合同/脚本/回归 | 实现与测试；**不写书** | 把工程当空库重建；改 evidence |
| **桌面 Owner** | 人 | 文学终审、状态 commit、硬冲突裁决 | `human_ui` save；`novel_review_chapter_state_candidate`；seed/recover | 把未裁决候选当正典对外引用 |

说明：Claude 可担任编排或只读交叉审，**不与千问同章拼盘正文**（一章一主笔）。

### G.2 工具权限矩阵（MCP / execute_command）

图例：✓ 允许 · ◐ 条件允许 · ✗ 禁止 · R 只读

| 工具 / 命令 | 编排 | 主笔 | 结构审 | 声口 | 探针 | Codex(书外) | human_ui |
|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| `get_capabilities` / active context | R | R | R | R | R | R | R |
| `get/acquire/heartbeat/release_studio_project_write_lease` | ✓ | ◐持票 | ✗ | ✗ | ✗ | ✗写书 | ✓桌面 |
| `get_novel_manuscript_workspace` | R | R | R | R | R | R | R |
| `list_novel_manuscript_chapters` | R | R | R | R | R | R | R |
| `read_novel_manuscript_range` | R | R | R | R | R | R | R |
| `search_novel_manuscript` | R | R | R | R | R | R | R |
| `get_novel_writing_state` | R | R | R | R | R | R | R |
| `build_novel_context_pack` continue/revise | ◐派工 | ✓ | ✗ | ◐窄改 | ✗ | ✗ | ✓ |
| `build_novel_context_pack` review | R | R | ✓ | ✓ | ✓ | R | R |
| `preflight_novel_chapter_write` | ◐代主笔 | ✓ | ✗ | ◐窄改 | ✗ | ✗ | 可选 |
| `novel_create_chapter`（**空** content） | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ | ✓可非空 |
| `novel_save_chapter` + `aiWriteContext` | ✗ | ✓ | ✗ | ◐编排签发 | ✗ | ✗ | ✓无 preflight |
| `novel_stage_chapter_state_candidate` | ✗ | ✓ | ◐草案 | ✗ | ✗ | ✗ | ✓ |
| `novel_attach_review_ticket` | ✗ | ◐自检 | ✓ | ✓ | ✓ | ✗书内 | ✓ |
| `novel_review_chapter_state_candidate` | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✓ **唯一** |
| `novel_seed_writing_state` | ◐冷启动一次 | ✗ | ✗ | ✗ | ✗ | ✗ | ✓ |
| `novel_recover_manuscript` | ◐外漂恢复 | ✗ | ✗ | ✗ | ✗ | 辅助脚本 | ✓ |
| rename/move/reorder | ◐ | ✗默认 | ✗ | ✗ | ✗ | ✗ | ✓ |
| 生图相关 studio 写命令 | 与小说租约隔离；同工程 hybrid 时分时持租约 | | | | | | |
| 私写 `MEMORY.md` / 会话笔记当正典 | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | 可本地草稿但不进 CAS |

**条件（◐）细则：**

1. **主笔持票**：编排可把 lease 转给主笔 session（`holderId` 稳定可辨，如 `qwen-lead-ch012`），或编排代持、主笔写时带同一 token。  
2. **声口窄改**：仅当编排写入任务卡 `taskType=revise_chapter` + 范围说明（对白区间），且 preflight 新鲜；否则只出 ticket。  
3. **结构审 stage**：V1 建议仍只允许**一个** pending candidate；结构审默认 ticket，避免与主笔 candidate 竞态（P1 可做 multi-candidate 合并 UI）。  
4. **seed**：全书仅一次；已存在失败关闭。

### G.3 write lease · actor · human_ui · agent 边界

#### 写租约（项目级所有权）

| 维度 | 合同 |
|---|---|
| 落盘 | `.aicanvas/write-lease.json` |
| holderKind 现有 | `grok` \| `codex` \| `agent` \| `desktop-ui` \| `script` |
| 现硬闸 | **生图**命令集（`STUDIO_WRITE_LEASE_ENFORCED_COMMANDS`） |
| 小说多 AI 目标 | 将 `novel_save_chapter` / `novel_create_chapter` / `novel_stage_*` / `novel_review_*` / `novel_seed_*` / `novel_recover_*` / rename·move·reorder **纳入同闸或 novel 专用闸**（见 D-P0） |
| 模式 | 生产 `require`：无租约不准写；有租约异主 `lease-held` / token mismatch |
| TTL | 建议章作业 15–30 min；heartbeat；异常 release 或过期 |
| 与文件锁 | 租约=**谁有权写**；`withProjectLock`=**同时写互斥**；二者并存 |
| hybrid 工程 | 生图租约与小说写**分时**，禁止「主笔写章同时另一代理 dispatch 生图」无协调 |

**推荐 holderId 命名：**

```
orch-grok-<sessionShort>
lead-qwen-ch<NNN>-a<attempt>
voice-doubao-ch<NNN>
desktop-ui-main
```

#### actor 边界（入口身份，非业务哈希）

| actor | 谁可设 | 行为 |
|---|---|---|
| `agent`（默认） | MCP / JSON CLI / 外部模型 | `novel_save_chapter` **必须** `aiWriteContext`；create 禁止非空 content；违反 → `context_preflight_required`（账本 I/O 前拒绝） |
| `human_ui` | **仅** Electron Main 内部（`src/main/index.ts` 显式传入） | 手改兼容，可无 preflight；**不进** MCP 公共 schema |
| 禁止 | 任何 AI | 在 payload 里伪造 human_ui、复用人类成功幂等键做无身份写入 |

`novelWriteActor` **不进入**业务请求哈希 / durable 业务身份，但必须在账本读取前完成授权检查（command-bus 已实现）。

#### 审稿票 vs 状态候选 vs 正文 CAS

| 产物 | 命令 | 绑定 | 是否改正典 | 多模型策略 |
|---|---|---|---|---|
| 正文 | `novel_save_chapter` | expectedRevision + sha256 + preflightId + packFingerprint | 是（正文） | **单主笔串行**；CAS 冲突则重读合并 |
| 审稿票 | `novel_attach_review_ticket` | 章 revision/sha + UTF-16 区间 + evidenceExcerpt | 否 | **多席并行**；`reviewer` 字段区席 |
| 状态候选 | `novel_stage_chapter_state_candidate` | 正文 CAS + writing-state CAS | 否 | V1 **每章一个 pending**；主笔 stage |
| 状态裁决 | `novel_review_chapter_state_candidate` | candidate fingerprint + state CAS | accept 才推进 completion | **仅 owner/human_ui** |
| 下一章 preflight | — | 上一章 completion + 正文未漂 | — | 缺 commit → `state_commit_required` |

### G.4 多模型流水线（标准章作业）

**Phase 0 · 编排开工**

1. 确认活动工程 / 显式 `projectRoot`（禁止列表偷选）。  
2. `acquire` 租约；记 `holderId`/`token` 到**编排侧作业单**（可落工程内 `.aicanvas/novel/jobs/`——产品增量，见 D；在落盘前可用 STATUS 临时）。  
3. 读 `writing_state` cutoff=before；检查 `state_commit_required` / 硬冲突。

**Phase 1 · 主笔写**

1. 空章 → pack(continue) → preflight → 生成 → save。  
2. 失败：`context_preflight_stale` → 全链路重读；CAS 冲突 → 重读正文；幂等重试同 key。  
3. 立即 `stage` 状态 delta（不得「先写十章再补状态」）。

**Phase 2 · 多席只读审（可并行）**

1. 各席 `review_chapter` pack（无写权）。  
2. 每发现一处问题一张 ticket：severity / impact / minimalFix / confidence / reviewer。  
3. P0 票（知情穿帮、硬正典、死人复活等）→ 编排阻塞 commit，打回主笔 `revise_chapter`。  
4. P1/P2 → owner 可读后决定是否改笔或忽略。

**Phase 3 · 人工 commit**

1. Owner 在 UI 看正文 + 票 + candidate diff。  
2. `accepted` → completion 推进；`rejected` → 主笔按 note 重 stage 或改正文（改正文会使旧 candidate 失效，需新 stage）。  
3. 禁止 AI 自 accept。

**Phase 4 · 关章**

1. 编排验证：目标章有 completion、无未裁决硬冲突、lease release。  
2. 下一章从 Phase 0 开始；**禁止**跨章复用 preflight/pack fingerprint。

### G.5 如何避免「每个 AI 各写一份记忆」

| 反模式 | 机械对策 |
|---|---|
| Claude MEMORY / Grok memory 记人物现状 | 写前强制 `get_novel_writing_state`；pack 已含八项；会话记忆**不得**覆盖 state |
| 千问本地 md「本章设定」 | 不进工程；设定变更必须进 source-objects 或 candidate |
| 各模型 transcript 当连续性 | 接力只认 manuscript revision + state fingerprint |
| 审稿模型「总结进自己笔记」 | 只允许 `novel_attach_review_ticket` 落盘；总结不进正典 |
| 编排 STATUS 当正典 | STATUS/TASKS 只记队列进度；人物事实以 writing-state 为准 |
| 多主笔各存一版正文 | CAS 单文件；第二写者必冲突失败 |
| 用聊天「大家记住 X」 | 无命令 = 未发生；必须 stage+accept |

**单一记忆公理：**

> 模型上下文 = **易失投影**；  
> Context Pack 2.0 = **受预算的只读投影**；  
> writing-state + manuscript = **唯一持久记忆**。

### G.6 失败与抢写场景剧本

| 场景 | 期望行为 |
|---|---|
| 两主笔同时 save 同章 | 租约挡一者；或 CAS revision 冲突，后者重读 |
| 审稿席误调 save | 无 lease / 策略层拒绝；即使调到也需 preflight（无编排签发则无 pack 任务） |
| 主笔 stage 后、commit 前又改正文 | 旧 candidate 与新 sha 不一致 → 拒绝 accept 或需重 stage |
| 上一章未 commit 开写下一章 | preflight `state_commit_required` |
| 外盘手改 md | `external_change`；recover 后再继续 |
| 租约过期中途 | heartbeat；过期后异主可抢；原写 CAS 仍以 revision 为准 |
| hybrid 生图与写章并行 | 分时租约；或 lease note 声明 scope（产品增量） |

---

## D. Top 10 产品改进（P0 / P1 / P2）

优先级对齐「多 AI 不抢写、不漂正典」；不推翻 Writing OS V1 主路径。

| # | 级 | 改进 | 接口形状 / 验收门 |
|---|---|---|---|
| 1 | **P0** | **小说写命令纳入写租约闸**（或 `NOVEL_WRITE_LEASE_ENFORCED_COMMANDS`） | save/create/stage/review/seed/recover/rename… 在 require 下无 token 失败；异主失败；只读永不要求。测：双 holder 抢 save |
| 2 | **P0** | **章作业单（job）落盘** `.aicanvas/novel/jobs/<chapterId>.json` | 字段：role, model, holderId, preflightId, packFingerprint, attempt, status。验收：崩溃后另一会话只读 job 恢复，不靠聊天 |
| 3 | **P0** | **角色策略配置** `story-bible/agent-roles.json`（或工程设置） | 声明 lead/struct/voice/probe 的允许 command 集合；MCP 或编排层 enforce。验收：struct 调 save → 稳定拒绝码 `role_forbidden` |
| 4 | **P0** | **reviewer 身份规范化** | ticket.reviewer 枚举/前缀 `struct:glm` / `voice:doubao` / `probe:ds`；列表 API 按席聚合。验收：并行 3 票可查询 |
| 5 | **P1** | **状态候选互斥** | 同章仅一个 `pending` candidate；第二 stage 需 supersede 显式标志。验收：双 stage 失败关闭 |
| 6 | **P1** | **lease 范围 scope** | `scope: "novel-manuscript" \| "studio-generation" \| "all"`；hybrid 分时。验收：持 novel scope 不能 dispatch 生图 |
| 7 | **P1** | **UI：票+candidate 并排审** | 桌面一屏：正文高亮 UTF-16 区间、票列表、delta diff、accept/reject。验收：Electron smoke |
| 8 | **P1** | **编排只读「下一动作」投影** | `get_novel_chapter_pipeline_status(chapterId)` → earliest 阻塞原因（缺 preflight/缺 commit/有 P0 票）。验收：与 preflight 理由一致 |
| 9 | **P2** | **声口窄写合同** | revise pack 可带 `constraint: { kind:"dialogue_only", spans? }`；保存后自动 diff 门禁（非对话行变更过大则 reject）。验收：乱改正文失败 |
| 10 | **P2** | **多 candidate 合并** | 主笔与结构审各 stage → owner 三路合并 UI；仍单次 accept 推 completion。验收：合并后 fingerprint 可复验 |

**MVP（2 周可执行切片）：** D1 + D2 + D3 + 现有 V1 主路径文档化（本文 G）+ 双代理抢写测试。  
不做：自动文学评分替代 owner；聊天记忆同步器；每模型私有 bible。

---

## I. 90 天路线图

### 0–30 天 · 锁门（多 AI 可接力）

- 落地 P0：小说写租约闸 + job 落盘 + 角色允许表（哪怕先编排层 soft enforce + 合同文档）。  
- 固化「一章一主笔」运行手册进 `AI_AGENT_CONTRACT` 附录（多模型）。  
- 验收：两进程（如 Grok 编排 + 千问主笔脚本）同工程；抢写失败；正常路径 save→ticket→stage→人工 accept→下一章 preflight ready。  
- 《黑页》隔离工程演练 1 章全席模拟（可 mock 模型，重在门）。

### 31–60 天 · 可观测与 UI

- P1：pending candidate 互斥、pipeline status 只读工具、桌面票/delta 并排。  
- lease scope 分离 hybrid。  
- 1M 字工程：连续 20 章「模拟多代理」soak（幂等、stale、commit 链）；外漂 recover 演练。  
- 结构审/探针真实模型抽样 3 章（出票质量人工抽检，不设文学 SLA）。

### 61–90 天 · 窄写与规模

- P2：声口 dialogue_only；多 candidate 合并（若 owner 需要）。  
- 角色策略与 MCP 硬 enforce（非仅编排约定）。  
- 与漫剧侧对照：小说 state ↔ 资产/连续性**引用**边界文档（不合并真相源）。  
- 关账门：合同测试矩阵（role×command）、双代理租约测试、500 章回归仍绿；文档与 `AI_AGENT_CONTRACT_V1` 同步。

### 明确不做（90 天内）

- 自动 accept 状态候选  
- 多主笔同章拼盘  
- 把 MEMORY/聊天同步进 writing-state  
- 推翻 P0–P14 漫剧 owner 或平行第二正文库  
- 用软件「保证文笔」

---

## 附：与 brief 其他字母的接口（本席不展开）

| 字母 | 本席产出如何被消费 |
|---|---|
| B 痛点表 | 「多模型各记一套」「抢写丢章」→ 用 G+D 对消 |
| E 人物一致性门 | 一律经 writing-state + pack cutoff；票审知情/禁揭 |
| F 百万字工程门 | job+lease+CAS+completion 链；禁止会话记忆续命 |
| H 不做清单 | 见 I 末与 G.5 |

---

## 实现时最关键的代码锚点（只读索引）

| 路径 | 为何关键 |
|---|---|
| `src/core/novel-agent-service.ts` | capabilities、pack/preflight 合同面 |
| `src/core/command-bus.ts` | `novelWriteActor` agent/human_ui 闸 |
| `src/core/studio-project-write-lease.ts` | 租约模式与硬闸命令集（需扩 novel） |
| `src/core/novel-writing-state.ts` | state/candidate/ticket 权威 |
| `src/core/novel-command-runtime.ts` | 可写命令 schema |
| `docs/novel-mode/AI_AGENT_CONTRACT_V1.md` | 对外操作合同 |
| `docs/MCP_写租约与唯一写入口_20260723.md` | 生图侧租约先例 |

---

## 本席验收自检

- [x] 回答 A/C/D/G/I  
- [x] 角色 ↔ MCP 权限矩阵  
- [x] write lease / actor / human_ui / agent  
- [x] 审稿票 · 状态候选 · 正文 CAS 流水线  
- [x] 反「每 AI 一份记忆」  
- [x] 可执行 P0/P1/P2 与 90 天路标  
- [x] 不修改业务源码；仅本裁决文档  

**结束语：** 多 AI 协作的产品形态不是「六个聊天室」，而是**一个 CAS 工程 + 分角色工具权限 + 候选/票/人工 commit**；模型可换，正典门不可换。
