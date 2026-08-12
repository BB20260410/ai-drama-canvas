# Writing OS V2：陌生 AI 测试小说的安全入口

## 先看结论

第一次接触本软件的 AI，不应自行拼装“读几章—写正文—保存”的流程。第一步固定调用 `doctor_novel_agent`；只有它返回 `readyForPrepare=true`，才调用 `prepare_novel_chapter_write` 获取本章 Context Pack、preflight 和唯一写租约。

传输名称已经统一以 `prepare_novel_chapter_write` 为 canonical 名：MCP 直接调用该工具；JSON CLI 的 schema v1 同时接受该名称与历史别名 `prepare_chapter_write`。能力清单的 `controlOperations[].transports` 会返回精确映射，Agent 不得凭字符串猜测跨传输名称。

正式正文的完整闭环是：

`doctor → prepare → CAS save → state candidate → human owner decision → consistency probe → doctor next chapter`

Agent 可以写正文、提出状态候选、运行探针；Agent 不能初始化或改写正式正典，不能接受自己的候选，审稿 Agent 不能写正文。

## 唯一记忆权威

schema v2 novel/hybrid 工程的当前公开正典投影只有 `story-bible/writing-state.json`；它由 `.aicanvas/novel/state-history/` 下的不可变 checkpoint/event、mutation intent/receipt 和可选 shadow rebuild control 共同保护。不要直接编辑这些文件。

- `.aicanvas/story/adaptation.json` 是 legacy 改编数据，只读保留，不会混入正式写章 Context Pack。
- 桌面“Writing OS 记忆”面板是当前章时态投影，不再直接写 legacy adaptation。
- 人物、硬正典、章 brief、人物声口、结构化外形和连续性问题的变更，必须先 `novel_stage_story_bible_candidate`，再由 `human_owner` 或 `human_ui` 调用 `novel_review_story_bible_candidate`。
- 外部资料目录不是运行时真相源。human owner 只能通过一次性只读预检导入 raw/text CAS 快照；工程长期保存不含绝对路径的 receipt。Agent 可用 `list_novel_writing_source_receipts` 与 `compare_novel_writing_source_receipts` 对账，再把选定的 `source_binding` 与正典修订放进同一个 Story Bible 候选。
- 动态人物状态、知情、关系、时间线和伏笔按章追加历史；旧章修订必须 invalidate 后按 rebuild queue 顺序重算。
- 旧章 invalidate 不会立刻回退公开 `writing-state.json`。Core 会创建 `rebuild_started` 事件和不可变 shadow lineage；只有最后一章重建 accepted 后，才把新 lineage 一次 promotion 为公开 head。

## 可直接复制给陌生 AI 的提示词

```text
你正在测试一部小说能否由“AI 漫剧无限画布”的 Novel Writing OS 安全辅助续写。

目标：只在隔离的 schema v2 managed novel/hybrid 工程内完成一个章节闭环，验证人物、知情、关系、日历、伏笔、正文 CAS 和状态提交；不得修改原小说源目录，不得跳过人工正典裁决，不得把机械检查说成文学质量通过。

硬规则：
1. 第一调用必须是 doctor_novel_agent。传入明确 projectRoot；未明确时只能使用软件返回的 active registration，禁止猜路径。
2. 默认 workflowMode=formal。只有 doctor 明确报告 baseline 未锁定、且本次任务被授权为隔离试验时，才可改为 rehearsal；rehearsal 结果不得同步为正式正文。
3. doctor 返回 blockers 时，只按其 nextTools 执行。需要 human owner 的步骤立即停下并报告，禁止伪造 owner、自动接受候选或自行锁定正典。
4. doctor 返回 readyForPrepare=true 后，调用 prepare_novel_chapter_write。不得自行分别拼 pack/preflight/租约，也不得在取得租约前并发生成第二份正文。
5. 只使用 prepare 返回的 Context Pack。不得搜索或读取 targetChapterId 之后的章节，不得读取 author_only 内容，不得依赖聊天记忆补全未来设定。
6. 写正文时严格执行：chapter brief、requiredCharacterIds、每个角色的基础卡、动态八项、知情边界、关系状态、时间线、伏笔、character profile 与 character appearance。声口 profile 的禁语/词汇/句式/关系对象声口，以及 appearance locks 的 canonicalDescription/allowedVariants/contradictionPhrases，都是正式约束；外形卡不得因预算被裁掉。
7. 保存正文只能调用 execute_command:novel_save_chapter，并原样携带 prepare 返回的 expectedRevision、expectedSha256、aiWriteContext、novelWriteLeaseToken 和本次真实 novelActorAttribution。任何 stale/conflict 都停止使用旧结果并重新 doctor/prepare。
8. 保存成功后，必须提交 novel_stage_chapter_state_candidate：
   - evidenceSpans 使用 UTF-16 code unit 半开区间，必须能从当前正文逐字复验；
   - 每项 delta 都有 kind、recordId、reason 和 evidenceSpanIds；
   - auditScope.checkedCharacterIds 必须与 required cast 完全一致；
   - 五类 checkedStateKinds 必须完整：character_state、knowledge、relationship、timeline、foreshadowing；
   - 没有状态变化时只能显式 noStateChange，仍需正文证据、完整 cast 和原因；不得提交空 delta 冒充完成。
9. Agent 不得调用 accepted/rejected 裁决自己的 chapter-state 或 Story Bible 候选。把 candidateId、fingerprint、writing-state revision/fingerprint 交给 human_owner。
10. owner accepted 后调用 probe_novel_chapter_consistency。machineConflicts 必须清零；reviewRequired 交人工判断。探针无命中只代表机械规则未发现问题，不代表人物魅力、心理真实、节奏、文风或文学质量通过。
11. 再调用 doctor_novel_agent。只有它推荐下一章且 readyForPrepare=true，才进入下一章。
12. 如果旧章正文被修改，先调用 plan_novel_state_rebuild；只能由 human owner 执行 novel_invalidate_writing_state_from，并严格按 rebuild.nextChapterId 顺序重算，禁止跳章。
13. 任一 doctor/prepare 返回 `state_history_recovery_required` 时，只执行其 nextTools 中的 `novel_recover_writing_state`。恢复器只接受 intent 声明的 before/after SHA；不得删除 operation、手改 control 或用第三份状态覆盖。`state_history_integrity_mismatch` 需要 human owner 检查，不能自动修复。
14. 可用 `get_novel_state_rebuild_status` 查看 public head、active shadow、pending operations 和完整 lineage 复验结果。`healthy=true` 才表示机械闭包成立；它不代表文学质量通过。
15. 外部设定资料发生变化时，不得让 Context Pack 实时读取桌面目录。由 human owner 重新生成一次性资料快照，再比较两份 receipt；modified/rename/deleted/untracked 只是证据 diff，不自动改正典。删除项不得自动移除，所有 source_binding 与语义修订都必须经 owner 接受。

测试交付必须包含：
- 工程身份、目标章、workflowMode、正文保存前后 revision/SHA；
- doctor/prepare/preflight/lease 结果摘要；
- 状态候选与 owner 裁决身份；
- probe 的 machineConflicts、reviewRequired 和限制说明；
- 原小说源目录 before/after manifest 是否完全一致；
- 明确结论：程序门通过/未通过、文学质量已审/未审、剩余人工问题。

现在开始：调用 doctor_novel_agent，不要先写正文。
```

## `doctor_novel_agent` 的裁决含义

`readyForPrepare=true` 只表示当前工程具备签发本章正式写租约的机械前提。常见 blocker：

| blocker | 含义 | 正确动作 |
|---|---|---|
| `writing_state_missing` | 尚无 Writing OS 正典/状态 | owner 提供并裁决 seed；Agent 不自建正式事实 |
| `baseline_not_locked` | 资料仍 provisional | owner 锁定，或明确只做 rehearsal |
| `required_cast_missing` | 章任务没有完整出场角色集合 | 提交 chapter brief Story Bible 候选 |
| `character_profile_missing` | required cast 缺结构化声口卡 | 提交 character_profile 候选并由 owner 接受 |
| `character_appearance_missing` | required cast 缺结构化外形 Authority | 提交 character_appearance 候选并由 owner 接受 |
| `character_state_missing` | 截止章缺人物动态八项 | 补上一章状态候选并由 owner 接受 |
| `state_commit_required` | 上一章正文和状态没有同 revision/SHA 闭环 | 完成上一章状态提交 |
| `chapter_write_lease_conflict` | 另一主笔已持有本章租约 | 不生成第二份正文；等待释放/到期后重试 |
| `critical_memory_budget_insufficient` | formal pack 无法完整容纳 cutoff 内时间线/伏笔 | 使用 nextTools 返回的最低 `maxCharacters` 重新 prepare；超过单包上限时交 owner 分片/收束，不得降级裁剪 |
| `state_rebuild_out_of_order` | 旧章修订后的重建顺序错误 | 只处理返回的 rebuild.nextChapterId |
| `state_history_recovery_required` | 某次状态 mutation 的 intent 已提交但 control/state/decision/receipt 尚未全部收敛 | 原样执行 nextTools 的 `novel_recover_writing_state`；第三种 SHA 会失败关闭 |
| `state_history_integrity_mismatch` | control、event、checkpoint、shadow 或 operation 工件结构/指纹/闭包损坏 | 停止写章，由 human owner 检查受管历史；不得自动覆盖 |
| `writing_source_integrity_mismatch` | 实际引用的 text CAS、receipt 或 raw provenance 损坏 | 停止 prepare；owner 对账受管 receipt/CAS，禁止回读外部目录静默补救 |

## 软件能保证与不能保证的边界

软件可以机械保证：章身份和 SHA/CAS、未来章读取边界、writer 可见性、required cast 的声口/外形/动态状态装载、formal 关键时间线/伏笔不被预算静默裁剪、章级唯一 writer、候选正文证据、Agent/owner 权限、受管资料 receipt/raw/text 闭包、append-only 状态 event/checkpoint、intent 驱动的故障恢复，以及旧章 shadow rebuild 的顺序推进和最终 promotion。

软件不能机械证明：人物是否有魅力、心理是否真实、对白是否高级、节奏是否好、文风是否自然、伏笔是否让读者满意。`probe_novel_chapter_consistency` 对禁词和身份问题可给 machine conflict；对知情、身体、关系、日历和伏笔的语义风险只给 review candidate，必须保留人工或独立审稿模型。
