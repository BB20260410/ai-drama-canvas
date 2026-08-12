# 产品架构席：无限画布如何真正辅助多 AI 写小说

**席位**：产品架构（人类作者 × Agent 分工 · 双模式隔离 · 数量级优势）  
**日期**：2026-08-02  
**依据**：`00_brief.md`、`AI_AGENT_CONTRACT_V1.md`、`07-writing-os-v1-delivery.md`、`00-scope-and-authority.md`、`01-data-contracts.md`、`NovelStudioView` / Writing OS 实现现状  
**边界**：只读分析；不改代码、不消耗额度、不写正式《黑页》

---

## A. 一句话结论

**Writing OS V1 已把「写章」变成可失败关闭的机械流水线，但还不是「靠系统写百万字」——数量级优势取决于把状态裁决、泄漏门、角色硬锁和 Agent 驾驶舱做成画布一等公民；仅靠 MCP 合同 + 文件夹聊天，人物一致性仍会在第 30–50 章后靠模型记忆硬扛并崩。**

---

## B. 当前能力 vs 真实写作痛点

| # | 真实写作痛点 | Writing OS / Lite UI 现状 | 缺口等级 | 说明 |
|---|---|---|---|---|
| 1 | 多模型接力丢设定 | `writing-state` + Context Pack 2.0 + preflight 指纹 | **部分解决** | 能喂截止态；模型是否**遵守**仍靠 prompt + 人工 |
| 2 | 人物外形/声口漂移 | 实体 `baseSummary` + 八项自由文本；无结构化外形/声口 schema | **P0 缺口** | 无机器可比对的「脸/声纹」硬锁 |
| 3 | 知情越界（角色知道不该知道的） | 知情记录 + cutoff 投影进 pack | **半门** | 时态不泄「未来章」；不自动扫正文是否越界 |
| 4 | 关系/仇恨/恋爱进度乱 | `relationships` 时态记录 | **半门** | 写入靠候选；无 UI Diff 面板、无冲突可视化 |
| 5 | 八项状态写后不同步 | stage candidate → 人工 commit；缺 commit 则下一章 `state_commit_required` | **机械已通** | 产品上仍是「Agent 记得做 + 人记得批」 |
| 6 | 禁揭/硬规则被写穿 | `hardCanon` + `mustNotDo`；冲突态 fail-closed | **半门** | 冲突靠 seed/人工标 `conflicted`；正文不自动 lint |
| 7 | 百万字搜不到/打不开 | 章级编辑、有界 read、1M/500 smoke 曾 PASS | **工程基线有** | UI 搜索仍偏慢（lite 曾 26s）；FTS 全门未关账 |
| 8 | 会话断了续不上 | CAS revision/SHA、command ledger、幂等键 | **强** | 比聊天好一个数量级；缺「写作任务队列」产品面 |
| 9 | 多代理同时改同一工程 | 漫剧有 write lease；小说侧复用 command bus，**无小说专用租约 UX** | **P1 缺口** | 异主写仍可能靠 CAS 撞车，体验差 |
| 10 | 人审状态候选太累 | MCP 有 `novel_review_chapter_state_candidate`；**UI 无一等 Diff 裁决台** | **P0 产品缺口** | 不做成桌面一键，owner 会绕过系统 |
| 11 | 审稿意见不回流 | `novel_attach_review_ticket` 只读票 | **半门** | 票不驱动重写 preflight / 不挡 commit |
| 12 | 小说↔漫剧互相污染 | `workspaceMode` + 分目录 owner | **合同有** | hybrid 切换存在；跨域写边界需产品明示 |
| 13 | 「模型自由发挥」绕门 | Agent 空章 create + `aiWriteContext` 强制；`human_ui` 隔离 | **加固 CLEAN** | 产品上 Agent 驾驶舱仍未可视化强制路径 |
| 14 | 长线大纲/卷纲与章脱节 | `chapterBriefs.mustDo/mustNotDo` | **半门** | 无卷/弧线层驾驶舱；无「本卷目标完成度」 |
| 15 | 聊天记忆被当正典 | 合同明确禁止 | **合同正确** | UI 仍像「编辑器+侧栏」，未教育用户系统路径 |

**尖锐判断（brief 必答）**：  
**仅靠当前 Writing OS，不能稳定支撑百万字人物一致性。**  
它支撑的是：**百万字可存、可查、可按章恢复、可拒绝脏写、可要求状态 commit 才续写。**  
它**不**支撑的是：**自动发现漂移、跨模型声口硬锁、正文越界扫描、低成本人工裁决、多代理角色编排。**  
差距不在「再多几个 MCP 工具」，而在 **UI 裁决面 + 一致性机械门 + 任务编排** 三层产品能力。

---

## C. 目标架构（文字组件图）

```text
┌─────────────────────────────────────────────────────────────────────────┐
│  Electron 桌面（人类一等界面）                                              │
│  ┌──────────────┐  ┌──────────────────┐  ┌────────────────────────────┐ │
│  │ 卷章导航/搜索  │  │ 章编辑器(human_ui) │  │ Writing Cockpit 驾驶舱      │ │
│  │ 仅当前章 DOM  │  │ CAS 保存/历史     │  │ ① 截止态卡片 ② 状态 Diff    │ │
│  │              │  │ 三方冲突 UI       │  │ ③ 审稿票队列 ④ Agent 路径灯  │ │
│  └──────┬───────┘  └────────┬─────────┘  └─────────────┬──────────────┘ │
│         │                   │ human_ui 写               │ 裁决/只读投影   │
└─────────┼───────────────────┼───────────────────────────┼────────────────┘
          │                   │                           │
          ▼                   ▼                           ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  Command Bus + Ledger + Project Lock（唯一写路径）                         │
│  novel_* 命令 · studio_* 命令 分命名空间；同 projectRoot 共享租约/账本        │
└─────────┬───────────────────────────────┬───────────────────────────────┘
          │                               │
          ▼                               ▼
┌──────────────────────────┐   ┌──────────────────────────────────────────┐
│ NovelRepository owner     │   │ Drama/Studio owners（P0–P14 已关账）      │
│ manuscript/**/*.md        │   │ material-studio.sqlite                   │
│ manuscript/chapters.json  │   │ studio-production.sqlite + CAS 媒体      │
│ story-bible/**            │   │ BindingSet / generation ledger           │
│ writing-state.json (CAS)  │   │ 禁止写 manuscript / writing-state        │
│ change-sets / reviews     │   │ 小说侧禁止写 generation / Review          │
│ writing-source-objects    │   │                                          │
│ novel-derived.sqlite*     │   │ *可删重建，非正典                          │
└────────────┬─────────────┘   └──────────────────┬───────────────────────┘
             │                                      │
             └──────────────┬───────────────────────┘
                            ▼
             managed-project.json
             workspaceMode = drama | novel | hybrid
             同一 projectRoot；模式决定默认视图与允许命令族

┌─────────────────────────────────────────────────────────────────────────┐
│  Agent 平面（Grok / Claude / Codex / 千问 / 豆包 / GLM）                    │
│  MCP 209 tools 子集 / novel:agent JSON CLI                                 │
│  强制路径：empty create → state(before) → pack2 → preflight → save         │
│           → review_ticket? → stage state candidate → **等人类 commit**    │
│  绝不：聊天记忆当真源、直写磁盘、无 preflight 改正文、自行 accept 正典        │
└─────────────────────────────────────────────────────────────────────────┘
```

### 分层职责（产品一句话）

| 层 | 职责 | 不做什么 |
|---|---|---|
| **画布 UI** | 让人看见截止态、批状态、盯路径灯、解冲突；人类正文编辑旁路 preflight | 不推导 nextAction；不在 renderer 写权威文件 |
| **MCP / CLI** | 让模型机械执行合同路径；有界读、指纹写 | 不提供「一键全接受」；不猜工程 |
| **CAS / 账本** | 身份、幂等、恢复、失败关闭 | 不保证文学质量 |
| **模型** | 生成正文/状态候选/审稿票 | 不拥有正典；不跨 cutoff |

---

## D. Top 10 产品改进（P0 / P1 / P2）

优先级定义：  
- **P0**：不做则 owner 绕开系统 / 多模型必然漂  
- **P1**：百万字与多代理接力的硬门槛  
- **P2**：数量级体验与 hybrid 产线闭环  

| 序 | 优先级 | 改进 | 可执行交付物 | 接口/形态 | 验收门 |
|---|---|---|---|---|---|
| 1 | **P0** | **状态裁决台（State Commit Board）** | 章保存后自动提示 stage 候选；左右 Diff：八项/知情/关系/伏笔；一键 accept/reject | UI → `novel_review_chapter_state_candidate`；列表 pending candidates | 无 pending 时下一章 preflight ready；reject 不改 writing-state SHA |
| 2 | **P0** | **Agent 路径灯 + 零说明下一动作** | 显示：空章？state 截止？pack 指纹？preflight ready？缺 commit？ | 只读投影：`get_writing_state` + preflight 结果映射 UI locator | 路径未完成时 UI 明确阻塞原因；Agent 与 UI 同文案 code |
| 3 | **P0** | **角色硬锁卡（Character Lock Card）** | 结构化字段：外形要点、声口样本 3–5 句、禁揭清单、已知/未知边界摘要；进 pack 硬预算段 | 扩展 entity 或 source-object schema；pack 保留序：硬正典后立刻角色锁 | 缺 L1 角色锁则 continue preflight `character_lock_required`（新码） |
| 4 | **P0** | **正文泄漏/禁揭机械扫描（写后门）** | save 后可选/强制：对 `mustNotDo`+`hardCanon`+他角 `unknown` 关键词/断言扫描；出 issue 列表 | `novel_attach_review_ticket` 增强或 `novel_run_consistency_scan` 只读 | 命中 P0 规则时 **挡 state accept**（不挡人类改文） |
| 5 | **P1** | **写作任务队列（Chapter Job Queue）** | 任务：continue/revise/review；绑定 chapterId、provider 角色、attempt、状态 | 类似 generation plan 的 novel plan：`create_novel_writing_plan` 等 | 崩溃后续跑 earliest job；同章非终态拒绝双派发 |
| 6 | **P1** | **多模型角色合同产品化** | UI/合同固定：主笔 / 结构审 / 声口 / 去 AI 味；审稿只能 ticket | capabilities 声明 roles；review pack 永不返回 writePreflight | 审稿模型调用 save → 稳定拒绝；主笔缺 pack → 拒绝 |
| 7 | **P1** | **百万字索引与热路径 SLA 产品化** | FTS5 派生索引；搜索 p95 门；章切换不挂载全书 | 删 `novel-derived.sqlite` 可重建；UI 永不全量 DOM | S1：热搜 p95≤150ms；章切换 p95≤300ms（对齐 03-acceptance） |
| 8 | **P1** | **小说写租约 UX** | 多 Agent 前 acquire lease；UI 显示 holder；异主写失败可读 | 复用/扩展 `studio-project-write-lease` 或 novel 专用 | 异主 `novel_save_chapter` fail-closed；同键幂等恢复 |
| 9 | **P2** | **卷/弧线驾驶舱** | 卷目标、伏笔热力图、角色弧进度、未回收 setup | 只读聚合 writing-state + briefs | 不写正典；点击跳 locator |
| 10 | **P2** | **hybrid 改编交接板** | 锁定小说版本 SHA → 短剧 script revision；反向不污染 | 已有「短剧交接」合同产品化 | 下游改分镜不改 manuscript aggregate SHA |

### MVP（建议 2–3 周可关账的最小集合）

只做 **#1 状态裁决台 + #2 路径灯 + #3 角色硬锁进 pack**。  
这三项一上，Grok/Codex/千问就从「靠聊天硬扛」变成「缺锁/缺 commit 写不进去」。

---

## E. 人物一致性机械门清单

下列每条必须是 **软件可判定** 的门，而不是 prompt 愿望。  
状态：`已有` / `半有` / `建议新增`。

### E1. 写前（preflight 族）

| 门 ID | 条件 | 失败码（建议/已有） | 状态 |
|---|---|---|---|
| W1 | 目标章存在；AI 新章必须先空 create | `context_preflight_required` | 已有 |
| W2 | 上一章有 accepted completion 且正文 SHA 未变 | `state_commit_required` | 已有 |
| W3 | pack 指纹与 state/manifest/章 CAS 一致 | `context_preflight_stale` | 已有 |
| W4 | 硬正典无 `conflicted` | `hard_canon_conflict` | 已有 |
| W5 | cutoff=`before`，pack 不含目标章及之后正文 | pack 构造 + 测试 | 已有（需持续 oracle） |
| W6 | 出场 L1/L2 角色具备硬锁卡（外形+声口+禁揭） | `character_lock_required` | **建议新增** |
| W7 | 章 brief 存在且 `mustDo/mustNotDo` 非空（可配置） | `chapter_brief_required` | **建议新增** |
| W8 | 知情投影只含 `effective` 且 order&lt;N | 投影单测 0 泄漏 | 半有（缺大规模 oracle 常态化） |

### E2. 写中（模型侧强制输入，不是自由发挥）

| 门 ID | 规则 | 状态 |
|---|---|---|
| M1 | Context Pack 保留序：硬正典 → 任务 → **角色锁** → 八项/知情 → 关系/日历/伏笔 → 正文证据 | 半有（角色锁未结构化） |
| M2 | 预算不够先裁正文；硬正典/任务/角色锁装不下 → 报错不静默丢 | 半有（锁未入硬段） |
| M3 | 禁止模型「参考聊天里的设定」；唯一输入 = pack + 有界 read/search 回执 | 合同有；产品需路径灯强化 |
| M4 | 跨模型只切换 **执行角色**，不切换 **正典文件** | 产品协议（见 G） |

### E3. 写后（save 后、commit 前）

| 门 ID | 规则 | 状态 |
|---|---|---|
| P1 | 正文 CAS 绑定 preflightId + pack fingerprint | 已有 |
| P2 | 状态候选必须绑定正文 revision/SHA + writing-state fingerprint | 已有 |
| P3 | 候选未 accept 前，下一章不可 ready | 已有 |
| P4 | 禁揭/硬规则/他角 unknown 扫描；P0 hit → 禁止 accept | **建议新增** |
| P5 | 声口样本相似度（可选启发式）仅出「需复核」票，不自动改文 | **建议 P2** |
| P6 | 审稿票不改正文、不进正典；可要求「重写 attempt」任务 | 半有 |

### E4. 八项动态 + 扩展硬锁（产品字段建议）

**已有八项**（`NovelCharacterDynamicFields`）：  
`body` · `emotion` · `known[]` · `unknown[]` · `relationships[]` · `goals[]` · `psychology` · `unresolved[]`

**建议升格为机械硬锁（不进自由散文）**：

| 字段 | 用途 | 门 |
|---|---|---|
| `appearanceBullets[]` | 外形不可漂要点 | 进 pack 硬段；改之需人工 |
| `voiceSamples[]` | 3–5 句声口金标 | 审稿对照 |
| `taboos[]` / 链到 `hardCanon` | 禁揭、禁行为 | P4 扫描 |
| `knowledgeBoundary` | 本章截止已知/未知摘要 | 与 knowledge 记录对账 |
| `relationshipEdges[]` | 结构化边，不仅是字符串 | Diff 可视化 |

**原则**：自由文本可以存在，但 **一致性门只认结构化字段 + 证据 span**。

---

## F. 百万字不崩的工程门（规模 / 锁 / 恢复）

### F1. 规模

| 门 | 要求 | 现状 | 动作 |
|---|---|---|---|
| 章级权威 | 正文按章 md；禁止单文件百万字编辑器 | 已有 | 保持 |
| 有界 IO | read ≤200k UTF-16/次；list 分页 ≤500 | 已有 | 保持 |
| 派生可扔 | `novel-derived.sqlite` 可删重建 | 合同有 | 做成备份排除默认项 |
| 热路径 | 热搜/状态/pack 的 p50/p95 入回归 | 1M 有点测，非 SLA | 把 03-acceptance S1 门挂 CI |
| DOM | 章列表虚拟化；编辑器只挂当前章 | 列表可能偏重 | 500 章 UI soak |
| writing-state 体积 | 单文件 64MB 上限；章 completion 线性涨 | 有上限 | 监控；远期分卷投影只读缓存 |
| 外部漂移 | SHA 不一致 → `external_change`，不吞 | 已有 | UI 三方 Diff 必须可见 |

**不做的假规模**：向量库当正典、全书写进一次 prompt、聊天摘要当状态。

### F2. 锁

| 门 | 要求 |
|---|---|
| 命令锁 | 所有 novel 写走 command bus；同实体 revision CAS |
| 工程锁 | 多 Agent 写同一 `projectRoot` 必须 lease；UI 显示 holder |
| 模式锁 | `drama` 工具不得写 `manuscript/`；`novel` 工具不得写 generation pack/raw |
| 人类/AI 锁 | `human_ui` 仅 Main 内部；MCP 不能降级 |
| 正典锁 | accept 状态仅 owner；模型永不 `decision=accepted` |

### F3. 恢复

| 场景 | 行为 |
|---|---|
| 进程杀在 save 中 | 账本终态未知 → 同 `idempotencyKey` 重试；禁止换键重放 |
| preflight 过期 | `context_preflight_stale` + 返回 `currentWritePreflightInput` |
| 缺状态 commit | `state_commit_required`；队列卡在「待裁决」 |
| 派生库坏 | 删 sqlite 重建；正文/state 不动 |
| 备份恢复 | 恢复到**新目录**；旧根零写（已有受管备份合同） |
| 长任务 | 磁盘 STATUS/计划 + novel job queue；不靠会话记忆 |

**百万字「不崩」定义（产品）**：  
任意时刻杀死 App / Agent，**重新打开后能指出 earliest 阻塞 code 与 locator，且权威文件聚合 SHA 可解释**——不是「模型还记得剧情」。

---

## G. 多 AI 协作协议（谁写 / 谁审 / 谁改状态）

### G1. 角色（软件强制，不靠自觉）

| 角色 | 允许操作 | 禁止 |
|---|---|---|
| **主笔**（千问/Claude/Grok 等，每章单一） | empty create、state、pack(`continue`/`revise`)、preflight、save 正文、stage 状态候选 | accept 正典；改 hardCanon；无 preflight 写正文 |
| **结构审**（GLM 等） | pack(`review_chapter`)、read/search、`novel_attach_review_ticket` | 任何正文 save；stage 状态（默认） |
| **声口/备笔**（豆包等） | 同主笔但仅限指定章 revise；或只出 ticket | 扩大知情；改关系正典 |
| **去 AI 味探针**（DeepSeek 等） | review ticket + 可选 revise（仍走 preflight） | 跳过状态 commit |
| **人类 Owner** | human_ui 改文、accept/reject 状态、改 hardCanon、seed、解冲突、hybrid 切换 | 把聊天记录标成 canon |

### G2. 每章时序（不可重排）

```text
1. Owner 确认章 brief / 角色锁（UI）
2. 主笔：state(before) → pack continue → preflight → 生成 → save
3. 结构审：review pack → tickets（P0/P1/P2 + 证据 span）
4. （可选）声口/去味：revise 循环，每次新 preflight
5. 主笔或专用「状态员」：stage chapter state candidate
6. Owner：Diff 裁决 accept/reject
7. 系统：completion 推进；下一章 earliest 解锁
```

**关键产品规则**：  
- **一章一主笔**：禁止同章多模型拼盘正文（合同外的文学规则 → 软件用 job.assignee 固化）。  
- **状态 commit 是章的完成定义**，不是正文 save。  
- **审稿票 P0 未清不得 accept 状态**（建议门 P4/G 联动）。

### G3. 跨模型接力最小包

Agent 换人时只交接：

1. `projectRoot` + `projectId` + manuscript revision  
2. `targetChapterId` + 当前 job 状态  
3. `writing-state.fingerprint` + `currentThroughChapterId`  
4. 未决 candidateId / ticketIds  
5. **禁止**交接：聊天摘要、未入库设定、模型自述记忆  

### G4. 与漫剧多代理的对齐

漫剧已有：write lease、generation plan、fail/cancel/retry、trace。  
小说应对齐概念但 **独立命令族**：

| 漫剧 | 小说对应 |
|---|---|
| BindingSet | Character Lock + hardCanon |
| freeze/dispatch/commit raw | pack/preflight/save |
| Review PASS | state candidate accept（人） |
| `get_studio_trace` | `get_novel_trace`（P2：by-chapter/by-candidate） |
| panel-run-in-flight | chapter-job-in-flight |

---

## H. 明确「软件做不到 / 不该做」

### 做不到（别写进 roadmap 当承诺）

1. **自动保证文学质量、人物魅力、文风统一到出版级**——只能机械一致与可恢复。  
2. **零人工写出不崩的百万字**——状态裁决与硬规则冲突必须有人。  
3. **从散文完美抽取八项状态**——抽取只能是候选，接受权在人。  
4. **跨模型「感觉一样」**——无声口硬锁与样本时，模型族差异不可消灭。  
5. **替代书内法（过手、正典、叙事伦理）**——书规在书内；软件只提供门。

### 不该做（做了会毁系统）

1. 聊天记忆 / 向量回忆 / 摘要 **升格为正典**。  
2. AI 一键全部 accept 正文或状态。  
3. 静默自动合并同名角色、静默选第一候选。  
4. 重建或平行 `material-studio` / 第二套正文 owner。  
5. 为小说引入第二运行栈（Python 服务当真源）而不经授权。  
6. 让 `human_ui` 对 MCP 可用，或让 Agent 借人类幂等键绕 preflight。  
7. 把漫剧 generation 失败重试语义套到「自动改小说正典」。  
8. 回写用户外部小说目录 / 权威参考图 / 已关账 evidence。  
9. 用「测试 PASS」宣称文学锁版或正式第 N 章完成。  
10. 在 hybrid 工程让短剧改动反写 `manuscript` / `writing-state`。

---

## I. 90 天路线图

### 第 0–30 天：关掉「人会绕开系统」的口子（MVP）

| 周 | 交付 | 验收 |
|---|---|---|
| W1 | 状态裁决台 UI：pending candidate 列表 + 字段 Diff + accept/reject | 人工 1 次点击完成 commit；reject 后 SHA 不变 |
| W1–2 | Agent 路径灯：与错误码同文案；缺 commit/stale/preflight 可视化 | 截图 + locator smoke |
| W2 | 角色硬锁卡 schema + 写入 pack 硬预算段 | 缺锁 preflight 失败；pack 单测 |
| W3 | 《黑页》隔离工程跑通「真模型一章」：主笔→票→状态→人批→下一章 ready | 隔离根 before/after 可审计；正式源零写 |
| W4 | 巩固：lease 显示、错误恢复文案、文档/合同补丁 | MCP contract 测试绿；无 Git 强推要求 |

**30 天完成定义**：owner 可以 **不打开终端** 完成「批状态」；Agent **不靠聊天设定** 续写下一章。

### 第 31–60 天：多模型与一致性门

| 项 | 交付 | 验收 |
|---|---|---|
| 写作任务队列 | continue/revise/review jobs；in-flight 互斥 | 杀进程后续 earliest |
| 角色分工 enforcement | review 无 writePreflight；主笔强制路径 | 负例测试全红转绿 |
| 写后一致性扫描 | hardCanon/mustNotDo/unknown 粗扫描 | P0 hit 挡 accept |
| FTS/热搜 | 派生索引 + S1 性能门 | p95 达标证据 JSON |
| 多模型实战 | 主笔+结构审各 3 章隔离书 | 状态 completion 链完整 |

### 第 61–90 天：百万字稳态 + hybrid 契合

| 项 | 交付 | 验收 |
|---|---|---|
| S1 全套 oracle | 未来泄漏 0；状态题 100% | `03-acceptance` 子集关账 |
| S3 导入/重建 | 300 万字夹具 | 资源门记录（未达可标部分完成） |
| 卷/弧线驾驶舱 | 伏笔热力、角色弧只读 | UI smoke |
| hybrid 交接板 | 锁小说版本 → 短剧不反写 | 双向 SHA 证据 |
| Trace | by-chapter / by-candidate 只读 | 与 P24 精神对齐、独立实现 |

**90 天北极星**：  
同一受管工程内，**任意两个模型交替写到第 50 章**，人物锁与知情边界以 **writing-state + tickets** 为据可审计；崩溃后 5 分钟内从路径灯恢复；**仍不宣称**文学质量或正式书锁版。

---

## 重点三问（产品架构专论）

### 1. 画布 UI 对人类作者 + Agent 的分工

| 对象 | UI 必须承担 | UI 绝不承担 |
|---|---|---|
| **人类作者** | 读/改当前章正文（`human_ui`）；维护角色硬锁与 hardCanon；**裁决**状态 Diff；解 `conflicted`；决定是否 hybrid 改编 | 手抄 fingerprint；在 renderer 直写 md/json；用聊天记录覆盖 CAS |
| **Agent** | 不「看见」自由白板；只走 MCP 合同；路径灯展示其阻塞 | 在 UI 里点「全部接受」；无票据改正典 |
| **共享可见** | 截止态卡片、pending 候选、审稿票、章 job 状态、错误码中文说明 | nextAction 由 UI 脑补（必须来自 core 投影） |

**分工原则**：  
- **人类负责价值判断与正典推进**  
- **Agent 负责受约束生成**  
- **软件负责不让任何一方在身份漂移时假装成功**

当前缺口：Lite UI 只有编辑器+手工记忆，**把本该是驾驶舱的能力全推给了 MCP 熟练用户**——这是产品而非合同失败。

### 2. 小说模式与漫剧模式如何共用受管工程而不互相污染

**共享什么**

- 同一 `projectRoot`、同一 `.aicanvas/managed-project.json`  
- 同一 command bus / 账本 /（建议）写租约  
- 同一备份/恢复到新目录能力  
- hybrid 下显式切换 `NovelStudioView` ↔ 短剧工作室  

**绝不共享什么（污染边界）**

| 域 | 权威路径 | 谁可写 |
|---|---|---|
| 小说正文 | `manuscript/**` | 仅 `NovelRepository` / novel 命令 |
| 写作状态 | `story-bible/writing-state.json` 等 | 仅 novel writing-state 命令 |
| 小说派生 | `.aicanvas/novel/**` | novel derived owner |
| 漫剧资产/生成 | `material-studio` / `studio-production` / media CAS | 仅 studio 命令 |
| 导入故事兼容 | `.aicanvas/story/` | import；**不反写**小说正典 |

**模式规则**

- `drama`：旧 manifest 缺省；零小说目录副作用  
- `novel`：默认小说壳；不初始化生成驾驶舱写路径  
- `hybrid`：双壳；**改编只能通过「锁定小说版本 → 短剧 script」单向交接**；短剧 Review/BindingSet 变化不得 revise manuscript  

**污染验收（必须可测）**

1. 在 hybrid 工程跑一轮 studio freeze/dispatch 模拟 → manuscript + writing-state aggregate SHA 不变  
2. 跑一轮 novel save/commit → generation ledger / raw tree 不变  
3. 旧 drama 工程打开 → 无 novel 目录被创建  

### 3. 什么产品能力让「用画布写百万字」比「纯文件夹 + 聊天」强一个数量级

文件夹+聊天的失败模式：设定在对话里、正典不可指、断会话即失忆、多模型各说各话、无法证明第 400 章没泄第 500 章的密。

画布要强 **≥10×**，靠的不是「更大的聊天窗」，而是下面 **七个可叠加杠杆**（缺一则倍数崩塌）：

| # | 杠杆 | 为什么是数量级 | 当前 |
|---|---|---|---|
| 1 | **身份化正文**（章 ID + revision + SHA + 有界 offset） | 任何争论可回指原文，不靠「模型记得」 | 有 |
| 2 | **截止态正典**（before/through 投影） | 未来泄漏从「自觉」变「装不进 pack」 | 有 |
| 3 | **写前门 + 指纹绑定 save** | 脏上下文无法落盘 | 有 |
| 4 | **状态 commit 门控下一章** | 长线不靠自觉更新设定集 | 有（缺 UI） |
| 5 | **角色硬锁 + 禁揭扫描** | 跨模型外形/声口/知情可机械拦 | **缺** |
| 6 | **裁决台把人的时间用在 Diff 而非找文件** | 人效 10×；否则系统被弃用 | **缺** |
| 7 | **任务队列 + 租约 + 崩溃恢复** | 多代理/多会话像流水线而非聊天室 | **缺** |

**数量级公式（产品语言）**：

```text
文件夹+聊天 ≈  O(会话记忆) × O(人工检索设定)
画布 Writing OS 目标 ≈ O(1 次 preflight) × O(字段级 Diff) × O(可恢复 job)
```

当 5+6+7 补齐后，50 章后的一致性成本接近线性；文件夹方案接近指数（重读、对账、口角、返工）。

**一句话产品定位**：  
无限画布小说模式不是「带 AI 的 Word」，而是 **以 CAS 为账本的写作一致性 OS**——模型是工人，owner 是判官，画布是法庭与流水线。

---

## 附录：对当前实现的产品取舍建议

1. **先做裁决台，再做自动抽取**——没有 accept UX，自动抽取只会制造垃圾候选。  
2. **角色锁用「短子弹列表」而非长 prose**——才进得起 pack 硬预算。  
3. **扫描门宁可少而狠**——10 条真 P0 禁揭，胜过 1000 条模糊文风规则。  
4. **hybrid 默认只读另一侧**——切换即换命令族白名单，降低误写。  
5. **正式《黑页》仍 provisional**——产品能力用隔离工程验收；不拿正式源当试验田。

---

## 本席结论复述

- **Writing OS V1 = 可关账的写章内核**，不是完整「AI 小说产品」。  
- **百万字人物一致性**差在：硬锁、写后扫描、裁决台、任务编排——不是差在「再接入一个模型」。  
- **画布胜出文件夹**的唯一路径：让模型 **不靠聊天也能写、写了也不能脏、脏了人也能 1 分钟裁完**。

---

*文档路径：`docs/novel-mode/adjudication_20260802_ai-novel-assist/01_subagent_product.md`*
