你是产品/写作系统评审席。不要写代码。用简体中文回答。

# 议题：无限画布如何真正辅助多 AI 写小说（人物一致性 · 百万字不崩）

## 背景（已有）
- 软件：AI 漫剧无限画布（Electron + MCP + CAS + command bus）
- 小说 Writing OS V1 已落地：manuscript CAS、writing-state 八项动态、Context Pack 2.0、preflight、AI save 指纹、状态候选人工 commit、review ticket
- 规模证据：1M/500 章导入与热搜索 smoke 曾 PASS（非长期 SLA）
- 正式生图侧另有 BindingSet/连续性/驾驶舱；小说侧与漫剧侧尚未完全同构
- 真实项目《黑页》在外部文件夹，provisional；画布隔离 pilot 不得当正典

## 核心问题
1. 软件如何**真正**辅助 Grok / Claude / Codex / 千问 / 豆包 / GLM 等写小说？
2. 如何做到**人物一致性**（外形、声口、知情边界、关系进度、八项状态、禁揭）跨模型不漂？
3. 能否支撑**约 100 万字**长程任务：不崩塌、可恢复、可多代理接力？
4. 画布 UI 与 MCP 各自该承担什么？什么绝不该让模型自由发挥？

## 约束
- 不推翻 P0–P14 已关账漫剧 owner
- 不把聊天记忆当真源；文件 + CAS + revision 是唯一真相
- 过手/正典等项目规则在书内；软件提供机械门，不替代文学判断
- 输出要可执行：优先级、MVP、接口形状、验收门

## 请回答结构
A. 一句话结论  
B. 当前能力 vs 真实写作痛点（表）  
C. 目标架构（组件图用文字）  
D. Top 10 产品改进（P0/P1/P2）  
E. 人物一致性机械门清单  
F. 百万字不崩的工程门（规模/锁/恢复）  
G. 多 AI 协作协议（谁写/谁审/谁改状态）  
H. 明确「软件做不到 / 不该做」  
I. 90 天路线图  


## 已有合同摘要（节选）
# AI 小说操作合同 V1（Writing OS 扩展）

## 结论

受管小说已经从“正文 CAS + 搜索 + 正文切片”扩展为可机械闭环的写章操作面：时态正典/人物状态投影 → Context Pack 2.0 → 写前 preflight → 指纹绑定的 AI 正文 CAS 保存 → 只读审稿票/状态候选 → 人工接受或拒绝 → 下一章 preflight。

合同标识仍为 `aicanvas.novel-agent`、`schemaVersion=1`，旧的正文读取和 V1 context pack 请求保持兼容。新增状态不建立 SQLite 或第二份正文：正文权威仍是 managed Markdown + manuscript manifest；写作状态权威是项目内单一 CAS 文件 `story-bible/writing-state.json`；源设定以 SHA-256 不可变对象保存并由状态记录引用。

本合同是“写作一致性操作系统”，不是自动文学质量保证。模型负责生成或审查候选内容；一致性来自状态截止章、来源 SHA、preflight/pack 指纹、正文 CAS 和人工状态 commit。

## 每章强制主路径

1. `get_novel_manuscript_workspace`：确认工程、workspace/manifest revision、章节规模。若目标新章尚不存在，先用 `novel_create_chapter` 创建**空章**；Agent 不得在 create payload 中直接塞正文。
2. `get_novel_writing_state(targetChapterId, cutoff="before")`：读取目标章之前的硬正典、角色八项动态状态、知情、关系、日历和伏笔。
3. `build_novel_context_pack(taskType, targetChapterId, ...)`：生成 Context Pack 2.0。续写传 `continue_chapter`，改旧章传 `revise_chapter`，审稿传 `review_chapter`。可写 pack 会返回派生的 `writePreflightInput`；审稿 pack 的该字段固定为 `null`。
4. `preflight_novel_chapter_write`：将上一步的 `writePreflightInput` **原样**作为输入，不手抄默认值。只有 `ready=true` 才能进入 AI 写入。
5. `execute_command → novel_save_chapter`：继续携带正文 `expectedRevision + expectedSha256`，AI 调用还必须携带 `aiWriteContext.preflightId + contextPackFingerprint`。
6. 审稿模型如需反馈，只执行 `novel_attach_review_ticket`；它必须绑定正文 revision/SHA 与 UTF-16 原文证据区间，不能改正文或正典。
7. 写后执行 `novel_stage_chapter_state_candidate`，提交八项动态状态、知情、关系、时间线和伏笔的 change-set 候选。
8. 人工 owner 执行 `novel_review_chapter_state_candidate(decision="accepted"|"rejected")`。候选未接受时不进入正典。
9. 接受后重新为下一章生成 pack 与 preflight。上一章正文变化或缺少状态 commit 时，下一章会失败关闭。

重试同一命令时复用原 `idempotencyKey`；输入内容变化必须使用新的 `requestId` 与 `idempotencyKey`。`projectRoot` 可显式传绝对路径；省略时只使用桌面软件明确登记且身份一致的活动工程，不猜测工程。

## MCP 只读工具

| 工具 | 关键输入 | 用途与边界 |
|---|---|---|
| `get_novel_manuscript_workspace` | `projectRoot?` | 工程身份、正文规模与 revision；不返回整本正文 |
| `list_novel_manuscript_chapters` | `offset`, `limit≤500` | 分页返回稳定章 ID、revision、SHA、字符数和 locator |
| `read_novel_manuscript_range` | `chapterId`, `startOffset`, `maxCharacters≤200000` | 按 UTF-16 半开区间有界读取；外部漂移时不返回污染正文 |
| `search_novel_manuscript` | `query`, `limit`, `maxHitsPerChapter` | 搜索权威 Markdown，返回可反查的 revision/SHA/UTF-16 区间 |
| `get_novel_writing_state` | `targetChapterId`, `cutoff=before|through`, `characterIds?` | 按截止章投影硬正典、八项角色状态、知情、关系、日历、伏笔 |
| `build_novel_context_pack` | `taskType?`, `targetChapterId?`, `characterIds?`, V1 旧参数 | 提供 task+target 时启用 2.0；旧请求继续走 V1 兼容路径 |
| `preflight_novel_chapter_write` | pack 返回的完整 `writePreflightInput` | 同参重建 pack，并核对正文/state/上一章 commit；只接受 continue/revise，不接受 review |
| `execute_command` | 命令信封 | 唯一 AI 写入口；所有写入仍走 command bus、账本、锁与 repository owner |

Context Pack 2.0 的保留顺序是：硬正典 → 目标章任务/细纲 → 目标角色基础与八项状态/知情 → 关系、日历、伏笔 → 最近正文/搜索证据。预算不足时先裁正文；硬正典与任务放不下会直接报错，不静默丢弃。正文和时态记录都遵守目标章 cutoff；整本审查不能伪装成普通续写请求。

`writePreflightInput` 完整绑定 `taskType/query/chapterIds/characterIds/maxCharacters/maxSearchHits/targetChapterId/contextPackFingerprint`。它是由 pack 派生的重放参数，不参与该 pack 自身的 semantic fingerprint。任一参数、正文、manifest 或 writing-state 漂移时，preflight 返回 `context_preflight_stale`，并附上当前 `currentWritePreflightInput` 供重新组包；不得只替换 fingerprint 后继续使用旧内容。

## 可写命令

正文与结构命令保持不变：

- `novel_initialize_manuscript`
- `novel_create_volume`
- `novel_create_chapter`
- `novel_save_chapter`
- `novel_rename_chapter`
- `novel_move_chapter`
- `novel_reorder_chapters`
- `novel_recover_manuscript`

Writing OS 新增命令：

- `novel_seed_writing_state`：一次性建立 provisional/locked 基线、来源对象、时态正典、章纲与已有章 completion。已存在时失败关闭。
- `novel_stage_chapter_state_candidate`：绑定正文 CAS 与 writing-state CAS，生成不可变状态候选，不改正典。
- `novel_review_chapter_state_candidate`：人工接受/拒绝候选；接受时只允许推进当前截止章的下一章。
- `novel_attach_review_ticket`：绑定正文证据区间的只读审稿票；不改正文、不自动成为正典。

Agent 创建新章时，`novel_create_chapter.payload.content` 必须省略或为空字符串。正文只能在空章建立后，经 Context Pack 2.0 与 preflight，再由 `novel_save_chapter` 写入。带正文的 create 与不带 `aiWriteContext` 的 save 都会在工程探测和命令账本 I/O 前以 `context_preflight_required` 拒绝。

AI 保存示例：

```json
{
  "command": "novel_save_chapter",
  "payload": {
    "chapterId": "目标章 UUID",
    "content": "完整新正文",
    "expectedRevision": 1,
    "expectedSha256": "读取时得到的64位SHA-256",
    "aiWriteContext": {
      "preflightId": "novel-write-preflight-...",
      "contextPackFingerprint": "64位Context Pack指纹"
    }
  }
}
```

人类桌面编辑器创建/保存正文继续兼容旧请求，不强制 `aiWriteContext`；只有桌面 Main 的内部入口会显式标记 `human_ui`。该标记不属于 MCP/JSON CLI 公共 schema，AI 入口不得借此降级绕过 preflight，也不能用人类入口已经成功的幂等键重放无身份写入。

## JSON CLI

入口：

```bash
cd /Users/hxx/Documents/无限画布
printf '%s' '{"schemaVersion":1,"operation":"capabilities"}' | npm run --silent novel:agent
```

JSON CLI 与 MCP 共用 `novel-agent-service.ts`，新增只读 operation：

- `get_writing_state`
- 扩展后的 `build_context_pack`
- `preflight_chapter_write`

写入仍使用 `execute_command`。每次 stdin 只输入一个 strict JSON；成功结构是 `{"schemaVersion":1,"ok":true,...}`，失败结构含稳定 `error.code/message/details` 并返回非零退出码。

Context Pack 2.0 请求示例：

```json
{
  "schemaVersion": 1,
  "operation": "build_context_pack",
  "projectRoot": "/绝对路径/受管小说工程",
  "input": {
    "taskType": "continue_chapter",
    "targetChapterId": "目标章 UUID",
    "characterIds": ["character-id"],
    "maxCharacters": 60000,
    "maxSearchHits": 20
  }
}
```

随后把返回的 `writePreflightInput` 整体作为 `preflight_chapter_write.input`。不要自行构造、漏传预算/搜索参数、缓存修改或跨章复用 preflight。`review_chapter` 返回 `writePreflightInput=null`，只能提交 `novel_attach_review_ticket`，不能换成 continue/revise 来获取正文写权限。

## 失败恢复语义

- `state_commit_required`：上一章正文 revision/SHA 已变化，或上一章没有被接受的状态 completion；先补写后候选与人工 commit。
- `context_preflight_required`：Agent 尝试在 `novel_create_chapter` 中直接写非空正文，或保存正文时未携带 `aiWriteContext`；先创建空章，再严格执行 pack → preflight → save。该拒绝不会创建命令账本或改正文。
- `context_preflight_stale`：pack/preflight、正文 manifest、目标章 CAS 或 writing-state 已漂移；重新读取 state、重新组包和 preflight，不能继续用旧身份。
- `hard_canon_conflict` / `conflicts`：存在未解决硬规则冲突；先由 owner 裁决正典。
- `external_change`：磁盘正文与 manifest 身份不一致；先走受管恢复，再搜索/读取。
- 正文 revision/SHA 冲突：重新读取当前正文并合并，用新命令身份保存。
- 网络/进程中断且副作用未知：请求内容不变时用原 `idempotencyKey` 重试，由命令账本返回原结果。

所有 offset 均为 JavaScript UTF

请严格按 brief 的 A–I 结构作答。要尖锐、可执行。特别判断：仅靠当前 Writing OS，能否支撑百万字人物一致性？差在哪？画布该补什么才能让 Grok/Codex/千问真正「靠系统写」而不是「靠聊天记忆硬扛」？
