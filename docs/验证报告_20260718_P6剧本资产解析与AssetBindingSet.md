# 验证报告：P6 剧本资产解析与 AssetBindingSet

日期：2026-07-18（Asia/Shanghai）  
工作区：`/Users/hxx/Documents/无限画布`  
隔离工程：`/Users/hxx/Documents/无限画布/projects/codex-ai-drama-studio`

## 1. 结论

P6 已完成并通过完整纵向验收。软件现在可以把剧本修订、章节/场景、15 秒单元和 2–6 宫格中的人物、场景、道具提及冻结为带 source span、revision、SHA 和类别的实体提案；精确 ID、正式名和 confirmed alias 可解释检索，歧义与未匹配项不会被静默选中。人工确认或排除后，系统创建内容寻址 `AssetBindingSet`，再由统一 `PanelReferenceResolution Core V2` 构建生成引用闭包。

零提案不等于自动通过。只有 user 或 Codex 阅读非空 source span 并追加真实说明，才会形成可追溯 `confirmed-empty` 空闭包；未经确认的空镜仍失败关闭。

本阶段仍是软件研发验收，不是第三季正式生产。隔离正式工程保持空库，没有导入旧第三季、生成正式图片或视频，也没有浏览器、上传、付费或 Git 操作。

## 2. 剧本来源与精确失效

- 剧本、提示词、章节和场景均保存不可变修订、正文 SHA 与 UTF-16 source span。
- 15 秒单元每格保留本地秒段和集内绝对秒段；UI 直接显示 Core 投影，不自行重算时间轴。
- 单格分析只读取该格 source span；章节或场景修订能定位到受影响宫格。
- 宫格 scope、文本 revision/SHA、确认别名、资产 semantic revision、Authority 或参考媒体 SHA 漂移时，仅使相关 BindingSet 与下游生成包过期。
- 无关宫格变化不会误伤已冻结 BindingSet。

## 3. 实体检索、消歧与空闭包

- 提案状态限定为 `matched / ambiguous / unmatched / excluded`。
- 精确 ID、正式名、confirmed alias 优先；词法索引使用 Aho–Corasick trie，模型候选只能作为待审建议。
- 同类多候选必须人工选择；UI 不自动采用第一项。
- 标注集包含 24 项资产、86 个实体提及、8 个显式歧义组和跨类别共享 source span。
- 实测 86/86 提案：Precision 1、精确别名准确率 1、Recall@5 1、静默歧义选择 0。
- 10,000 资产 / 30,000 identity group / 6 宫格索引基准通过；最终构建约 49–52 ms，P95 查询约 0.07–0.08 ms，远低于门禁。
- `confirmed-empty` 追加 reviewer、note、source span、analysis/binding scope fingerprint 和独立 head revision；过期确认不能冻结新空 BindingSet。

## 4. BindingSet、统一引用闭包与生成结果

- `AssetBindingSet` 内容寻址并追加历史，记录 required/optional/forbidden、角色作用、剧本证据、资产版本、Authority、媒体 SHA、时间范围和确认决策。
- 显式空闭包冻结 0 decisions、0 asset sources，并依赖唯一 `entity-closure-confirmation`；不得同时含资产绑定。
- 所有引用继续经过 `PanelReferenceResolution Core V2`，没有新增平行参考真相源。
- 冻结 generation pack 后必须先写本地 dispatch intent；未 dispatch 的结果拒绝登记。
- 远端或模型晚返回时，即使输入已经漂移，结果仍可挂回原冻结包，但只能保持 pending，并返回 `inputCurrent=false / promotionEligible=false` 与明确 stale reasons。
- raw/labeled 配对、pack fingerprint、媒体 SHA 和当前输入闭包全部通过后，结果才允许进入 Review/提升流程。

## 5. 原子命令、恢复与接口

- analyze、resolve、confirm-empty、freeze 的业务行、head 和不可变 operation receipt 在同一 SQLite `BEGIN IMMEDIATE` 事务提交。
- receipt 写入前故障会整体回滚；提交后返回前崩溃可凭 receipt 恢复，不增加业务 revision、不重放。
- 四种绑定写操作全部经过统一 `executeStudioCommand`；Electron 不暴露旁路写 IPC。
- IPC 强制 `reviewer=user`，MCP 强制 `reviewer=codex`，直接命令总线只用于受信执行上下文。
- compiled MCP 精确为 180 tools，并包含绑定读取、统一命令、生成控制和 confirmed-empty 合同。

## 6. 真实 UI 验收

确定性 Electron fixture 使用一个严格 15 秒二宫格：

1. 第一格显示精确别名与两个同类歧义候选；人工接受/选择后冻结普通 BindingSet。
2. 第二格只有环境动作；分析得到 0 提案后，必须填写 user 审阅说明、追加 confirmed-empty 收据，再冻结 0 资产 BindingSet。

两格最终均为 `generation-ready/current`，Core 推导的唯一下一动作变为“全部宫格绑定已就绪，可由 Codex 冻结下一个单图生成包”。截图为 3456×2058 PNG、411,856 bytes，0 page error、0 外网请求。

## 7. 测试与最终验收

- typecheck：通过
- P6 定向：18 files / 90 tests，无失败、无 skip、无 todo
- 全量：88 files / 555 tests，无失败、无 skip、无 todo
- production build：通过
- MCP build 与 compiled MCP smoke：通过，180 tools
- 独立标注检索：24 assets / 86 labels / 86 proposals，Precision 与 Recall 均为 1
- 正式隔离工程：验证前后逻辑快照与全树身份一致，业务计数仍为 0
- 第三季只读源前后：3344 files / 24,570,877 bytes / `649160f22663ca4c45ee4a4084e278ef0edc61ec66db01bb84da38cbea3f8d26`
- 正式媒体、外部生成、imagegen、浏览器、上传和 Git 操作：全部 0

最终验证器前两次正确失败关闭并保留日志：第一次缺少 Vitest verbose 导致运行标记不可观测；第二次把跨类别共享 source span 重复物化，得到 92 个重复提案。验证器随后改为详细输出并按 `sourceSpanId` 只物化一次原文，第三次完整运行通过。

## 8. 权威证据

- `docs/evidence/final-validation-20260718-p6-asset-binding.json`
- `docs/evidence/runs/p6-asset-binding-final-20260718-03/`
- `docs/evidence/p6-binding-workbench-ui-smoke-20260718-04.json`
- `docs/evidence/p6-binding-workbench-ui-smoke-20260718-04.png`
- `scripts/validate-p6-asset-binding-final.ts`

## 9. 下一唯一最高优先级

P7“正式连续性账本与 Review 写回”：以逐原镜、逐宫格的不连续跨度记录服装、伤势、持物、位置、朝向、情绪、布局、光线和参考 SHA；未知值必须是 `unresolved`。状态与人工修正使用 CAS 和追加历史，未解决冲突或缺少必需状态时阻断生成；后续格可显式引用上一格已验收 raw；每完成 6 张生产图必须通过内容寻址一致性停检。

P7 继续只使用隔离确定性 fixture，不执行正式生图、浏览器、上传、付费或旧第三季导入。
