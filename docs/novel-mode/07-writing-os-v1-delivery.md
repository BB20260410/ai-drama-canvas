# 小说 Writing OS V1 交付报告

## 交付结论

**软件写章闭环已完成并通过机械终验；《黑页》正式小说仍为 provisional，未写正式第011章。**

现有受管小说能力已从“正文 CAS + 搜索 + 正文上下文”扩展为：来源可追溯的时态正典/人物状态、Context Pack 2.0、写前 preflight、指纹绑定 AI 保存、只读审稿票、写后状态候选和人工 commit。所有写入继续复用 command bus、命令账本、锁与唯一 `NovelRepository`，没有新增第二正文 owner、SQLite 正典或聊天记忆真相源。

## 核心实现

### 单一状态权威

- `story-bible/writing-state.json`：单文件 CAS 权威，记录 baseline、来源引用、角色基础卡、八项动态状态、知情、关系、时间线、伏笔、章纲与 chapter completion。
- `.aicanvas/novel/writing-source-objects/sha256/`：按 SHA-256 保存不可变设定源对象；状态只引用对象与来源 ID。
- `.aicanvas/novel/change-sets/`、`change-set-decisions/`、`reviews/`：不可变候选、人工裁决和审稿票；它们不能直接覆盖正文或正典。

### Context Pack 2.0 与写前门

- `taskType + targetChapterId` 开启 2.0；旧请求继续使用 V1 正文 pack。
- 优先级固定为硬正典、目标章任务、目标角色状态/知情、关系/日历/伏笔、正文证据。
- 正文先被预算裁剪；硬正典和任务装不下会失败关闭。
- 可写 pack 返回 canonical `writePreflightInput`，完整镜像 task/query/chapter/character/预算/搜索上限；review pack 返回 `null`，不能获取正文写 preflight。
- preflight 绑定目标章、cutoff、manuscript revision、目标章 revision/SHA、writing-state revision/fingerprint 与 pack fingerprint；调用方应原样使用 pack 返回的完整输入。
- Agent 只能用 `novel_create_chapter` 建立空章；非空 create 与无 `aiWriteContext` 的 save 都在账本 I/O 前以 `context_preflight_required` 失败关闭。人类桌面 Main 仅通过内部显式 `human_ui` actor 保持创建/保存兼容。

### 写后状态与审稿边界

- 保存正文不会自动改状态正典。
- 状态候选绑定正文 CAS 与 writing-state CAS；只有人工接受才推进 `currentThroughChapterId` 并产生 completion。
- 上一章缺少 completion 或正文已变更时，下一章 preflight 返回 `state_commit_required`。
- 外部模型只能附加结构化 review ticket；票据绑定正文 SHA 与 UTF-16 证据区间，不能改正文或自动成为 canon。

## 《黑页》第011章隔离 pilot

正式源只读前后清单：

| 指标 | before | after | 结果 |
|---|---:|---:|---|
| entries | 547 | 547 | 相同 |
| files | 507 | 507 | 相同 |
| bytes | 5,943,649 | 5,943,649 | 相同 |
| aggregate SHA-256 | `67da96a088bc83a60b8a1d3c716c19d2ae484cd575a4ac4f31c4114789fcfd70` | 同左 | 完全相同 |

隔离工程导入并复核了 001–010：每章受管 Markdown 的 SHA、byteLength 与只读来源一致，charCount 由落盘正文重新计算。状态映射包含 26 份来源对象、17 个角色实体、8 张第010章末动态卡、173 条知情、5 条关系、11 条时间线、28 条伏笔和29条硬正典。

第011章只写入 56 UTF-16 字符的“隔离演练”正文，完成：

1. 010 截止的 Context Pack 2.0；正文 excerpts 只来自 008–010。
2. `preflightId=novel-write-preflight-377b2df81f0bee43747702f5`。
3. AI CAS 保存至 revision 2。
4. 用旧 preflight 再保存，稳定拒绝为 `context_preflight_stale`。
5. 附加只读 review ticket；正文未变化。
6. 生成状态候选并由模拟人工 owner 接受，state revision 1→2。
7. 第012章重新组包，`preflightId=novel-write-preflight-63fb36c727899ed016fc946c`、`ready=true`。

该演练正文没有同步回正式源；第012章仍是空白 rehearsal 章。

## 规模、运行时与 UI 证据

| 验收 | 实测结果 |
|---|---|
| Codex ↔ Grok 加固定向 | 4 files / 29 tests PASS；Grok 最终 `CLEAN` |
| 最终小说/runtime 回归 | 28 files / 258 tests PASS；369.10 s |
| currentness 专项 | 1 file / 4 tests PASS；旧 candidate 对新源码先失败关闭 |
| TypeScript | PASS |
| `git diff --check` | PASS |
| 源码 MCP | 209 tools，真实 stdio 测试 PASS |
| MCP/CLI 小型闭环 | state/pack/preflight 语义等价；save/replay/stale/review/commit/下一章 preflight PASS |
| 1M/500 导入 | 1,000,000 UTF-16 字符、500章；33,999 ms |
| 1M 状态 seed | 499 个 completion；744 ms |
| Context Pack 2.0 | 4,096 字符；41 ms；确定性重复；目标章排除；locator 反查 PASS |
| 热搜索 | 109 ms；扫描 500；外部变化 0；唯一命中 1 |
| current immutable MCP | candidate `mcp-candidate-1b6f4a86544e89ff-3a7f2fd615601270-ef0fd9bc`；sourceDigest `1b6f4a86…02da4`；build `7af833522c34ba9b547935c9339a6153`；209 tools；invalid 0 |
| Electron | 百字隔离导入/搜索/记忆/编辑保存 PASS；1728×1029 截图；零外部请求 |

第一次尝试复用旧 P1 路由 smoke 时，脚本等待已被后续可写小说界面移除的 `novel-readonly-banner` 而超时；该脚本在失败清理路径中删除了输出并移除临时工程。随后使用当前 `ui-novel-lite-1m-smoke.ts` 的 `short100` 配置完成有效 Electron 验收。此失败不被隐藏，也不被计为产品回归失败。

## 决定性证据

- 总验收：`docs/evidence/novel-agent-contract-v1/writing-os-v1-final-validation-r2.json`
- Codex ↔ Grok 加固：`docs/evidence/novel-agent-contract-v1/grok-writing-os-hardening-20260802.json`
- MCP/CLI 与 1M/500：`docs/evidence/novel-agent-contract-v1/writing-os-v1-1m-500-acceptance.json`
- 《黑页》pilot：`docs/evidence/novel-mode-v1/real-project/black-page-ch011-managed-pilot.json`
- 正式源 before/after：`docs/evidence/novel-mode-v1/real-project/black-page-ch011-pilot-before.json`、`black-page-ch011-pilot-after.json`
- Electron：`docs/evidence/novel-mode-lite-v1/writing-os-v1-ui-smoke.json` 与同名 PNG
- AI 调用协议：`docs/novel-mode/AI_AGENT_CONTRACT_V1.md`

## 当前边界与风险

- 《黑页》不能宣称 001–010 已完成正式 Opus 锁版：逐章证据显示 001–005 成功，006–010 因会话额度失败；007/008 低于既定字数门。脚本输出 `ALL_OPUS_DONE` 不是可信锁版证据。
- 本轮只交付软件写章闭环和隔离 pilot，不写、不发布正式第011章。
- 初次 Writing OS 交付没有调用远程模型；本次后续加固按用户明确要求使用 Grok CLI 做了多轮只读代码复审，禁用 web search、memory、subagents，最终返回 `CLEAN`。没有外站上传、付费、部署或发布。
- Electron 证据是机械交互与截图质量检查，不是人工 UI 视觉批准；没有做文学质量、文风、人物魅力或长线剧情人工验收。
- current 候选只新增到开发工作区隐藏目录；没有替换 `/Applications/AI 漫剧画布.app`。
- 保留工作区既有 dirty work；没有 Git stage、commit、push 或 PR。

## 推荐下一步

等《黑页》CH006–010 终润真正补齐并通过字数/多模验收后，重新捕获 locked before manifest，再用同一只读导入流程建立正式受管基线。正式写第011章时先创建空章，再严格执行 `state(before) → pack 2.0（消费 writePreflightInput）→ preflight → AI CAS save → review → state candidate → 人工 commit`，不得复用本次 rehearsal 正文或 preflight。
