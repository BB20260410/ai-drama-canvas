# AI 小说操作合同 V1（Writing OS 扩展）

> 当前陌生 AI 的正式入口、人物声口门、章级租约、Story Bible 权威、写后 probe 与 retcon rebuild 已升级；请优先使用 [Writing OS V2 陌生 AI 快速入口](./08-writing-os-v2-unfamiliar-ai-quickstart.md)。本文件保留 V1 基础合同与历史兼容说明。

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

所有 offset 均为 JavaScript UTF-16 code unit，区间为 `[startOffset, endOffset)`，不得从代理对中间切分。

## 当前机械验收

- Codex ↔ Grok 加固定向：4 个测试文件、29 项通过；Grok 最终代码复审 `CLEAN`，无剩余可复现 P0/P1。
- Core/CLI/IPC/MCP/小说最终回归：28 个测试文件、258 项通过，369.10 秒；currentness 专项 4/4、TypeScript 与 `git diff --check` 通过。
- 当前 immutable MCP：209 tools，`sourceDigest=1b6f4a86544e89ff06ce7552e66328634bb226b86563f4a07a9b09c169902da4`，build `7af833522c34ba9b547935c9339a6153`，invalid candidate 0。候选构建前后 live `dist-mcp` fingerprint 均为 `b4ada036…16d79`，未替换 live 或安装版。
- 新 candidate 真实 stdio 探针：209 tools；capabilities 返回 `agentChapterBodyWrites=empty-create-then-context-pack-preflight-save`、`humanDesktopCompatibility=explicit-human-ui-actor`；写 preflight 的 taskType 仅为 continue/revise。
- 《黑页》加固后再次双扫描：547 entries、507 files、5,943,649 bytes、聚合 SHA `67da96a088bc83a60b8a1d3c716c19d2ae484cd575a4ac4f31c4114789fcfd70`，与最初 before/after 完全相同。
- 此前 Writing OS R2 的 100 万 UTF-16 字符 / 500 章实测为 Context Pack 2.0 41 ms、热搜索 109 ms、扫描 500、外部漂移 0、locator 可反查；本次安全加固未重跑性能计时，因此这些数值是前序基线，不是本轮新 SLA。
- Electron 百字隔离 smoke 是前序机械 UI 证据；本轮没有重新做人工 UI 或文学质量验收。

当前加固结构化证据：`docs/evidence/novel-agent-contract-v1/grok-writing-os-hardening-20260802.json`。此前 `writing-os-v1-final-validation-r2.json` 保留为加固前历史基线，不冒充当前源码身份。

## 明确未完成边界

- 《黑页》正式源当前仍为 `provisional`：现有证据显示 CH001–005 的 Opus 终润成功，CH006–010 因会话额度失败，且 CH007/008 未过既定字数门；不得称 001–010 已正式锁版。
- 本轮没有写《黑页》正式第011章，没有同步隔离演练正文，没有调用远程模型或消耗额度。
- 没有人工文学质量评审，也没有人工视觉 UI 验收；机械 smoke 不等于文风、人物魅力或界面体验通过。
- 没有替换 `/Applications` 安装版，没有部署、发布、Git stage、commit、push 或 PR。
