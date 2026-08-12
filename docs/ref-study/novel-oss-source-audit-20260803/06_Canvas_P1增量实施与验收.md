# Canvas Writing OS P1 clean-room 增量实施与验收

## 结论

**已完成。** 源码审计确认的三个 P1 已全部在 Canvas 现有 owner 内纵向落地，没有引入第二正典、第二章节库或外仓运行时：

1. NOVEL-DERIVED-SEARCH-GENERATION：Canvas-owned FTS5 派生索引代际；
2. NOVEL-ANALYSIS-EXECUTION-RECONCILIATION：外模执行崩溃后的显式人工对账；
3. KERNEL-PACK-TRACE-SURFACE：Context Pack 逐项选择轨迹、持久回执与 Dashboard 投影。

最终裁决为：**VERIFIED_P1_COMPLETE_WITH_SCALE_BOUNDARY**。

这表示三个已知 P1 已机械闭环并在 500/1000 章隔离夹具上通过，不表示任何模型、文风、硬件或未来 100 万字连载都能被无条件保证。

## P1-A：派生 FTS5 索引代际

- 唯一正文 owner 仍是 chapter manifest + Markdown 正文；派生库固定为 .aicanvas/novel/novel-derived.sqlite。
- 只有显式 novel_rebuild_search_index 会创建或重建索引；普通读取/搜索不会暗中写库。
- generation 绑定 project、manifest revision/digest、tokenizer、chapter revision/SHA 与文件身份。
- 生命周期覆盖 building / active / inactive / failed / stale；构建完成后才切换 active。
- fresh generation 只召回候选章，最终 offset、snippet、SHA 与正文仍从候选 Markdown 重读复验。
- 缺失、构建中、stale、损坏、短查询或章节身份漂移时，带明确 fallbackReason 回退完整线性扫描。
- 公共诊断增加 get_novel_search_index_status；MCP 工具总数最终为 218。

### 规模实测

| 规模 | rebuild | 索引查询 P50 | 索引查询 P95 | 实际重读章 | 观察 RSS 峰值 |
|---|---:|---:|---:|---:|---:|
| 500 章 / 100 万字符 | 271.78 ms | 215.65 ms | 219.51 ms | 1 | 325,451,776 B |
| 1000 章 / 200 万字符 | 405.34 ms | 418.00 ms | 420.51 ms | 1 | 367,378,432 B |

两组来源 SHA 与受管章节 aggregate identity 均前后相同。RSS 是同一 Node 进程的观察值，不是可移植内存 SLA。

## P1-B：外模执行崩溃对账

- analysis execution 增加 ownerId、fence、heartbeat/lease、dispatch checkpoint、proposal SHA 与 reconciliation 记录。
- 持久 checkpoint 区分 intent_persisted → request_dispatched → response_persisted。
- 过期 executing/submitting 投影为 reconciliation_required，不自动失败、也不自动创建 replacement。
- 新增只读 get_novel_analysis_execution_recovery。
- 高风险转换只经 execute_command：mark_novel_analysis_execution_reconciliation_required 与 reconcile_novel_analysis_execution。
- found 只能回收已持久 proposal 后离线提交；not_found 仍需显式 confirmNoRemoteResult 才允许 replacement。
- 旧 worker/fence 的迟到回写失败关闭；对账操作本身不发网络请求。

本地受控 HTTP provider 覆盖 dispatch 前后中断、POST 已到服务端后崩溃、response/proposal 已持久但未提交三条路径，均证明不会自动第二次 POST。

## P1-C：Context Pack 选择轨迹与回执

- pack owner 逐项记录 hard canon、精确目标章 brief、required cast、角色动态/知情/关系、timeline、foreshadowing 与 recent chapter excerpts。
- 每项记录 included/omitted、source ID、priority、rule/reason、protected/compressible 与字符成本。
- 预算分区明确为 hard requirements、required cast、critical memory、recent chapters。
- selection trace 在既有 pack semantic fingerprint 之后附加，因此未改变原有 pack/preflight/save 指纹合同。
- 成功 preflight 后生成 content-free receipt，并随 chapter write lease 在同一次 CAS 中原子落盘。
- receipt 绑定 target revision/SHA、cutoff、manifest、writing state、pack fingerprint 与 preflight id。
- Dashboard/NovelStudioView 只读取持久 receipt，不重新计算选择。
- receipt 不持久正文、绝对路径、objectRelativePath、author-only canon 或未来章信息。

## 验证证据

| 门 | 结果 |
|---|---|
| P1-C 定向闭环 | 3 files / 32 tests PASS |
| allowlist/IPC 合同复验 | 2 files / 17 tests PASS |
| Codex Doctor 专项 | 1 file / 8 tests PASS |
| 小说相关全量回归 | 30 files / 61 suites / 289 tests PASS |
| TypeScript/Vue | npm run typecheck PASS |
| diff whitespace | git diff --check PASS |
| MCP currentness | candidate mcp-candidate-c32676d385437104-88c6696054753099-20bcfb2d，218 tools，52 candidates，invalid 0 |
| 真实 current stdio | SDK tools/list 与 capabilities 同为 218，buildCurrentness allowed=true |
| 正式《黑页》零写 | 566 entries 全量相同，aggregate 97e8fde0ee0ea8ce8529c3db7db4d2d412cbaf0b8f7ff1e837d185f01b89bada |

决定性机器证据：

- docs/evidence/novel-user-tests/p1-cleanroom-deltas-20260803.json
- docs/evidence/novel-user-tests/p1-full-regression-final-20260803.json
- docs/evidence/novel-user-tests/p1-derived-search-performance-final-20260803.json
- docs/evidence/novel-user-tests/p1-current-mcp-smoke-authoritative-20260803.json
- docs/evidence/novel-mode-v1/real-project/black-page-novel-p1-final-after-20260803.json

## 边界与剩余风险

- 未调用真实外部小说模型；崩溃/重复 POST 通过本地受控 HTTP provider 验证。
- 未做文学质量、文风或商业连载质量裁决；软件约束一致性，不替代主笔与人工审稿。
- 性能实测到 1000 章/200 万字符。索引查询仍会先验证 allowed scope 中全部章节的文件身份，因此元数据校验成本随章节数增长；更大规模仍需持续观察。
- P2 知情来源/置信度/秘密级别和叙事承诺诊断仍保持 defer，未被擅自升级为 owner 字段。
- 正式《黑页》没有被导入、锁版或续写；其当前资料/文学门仍按正式项目自己的 owner 裁决。
- 没有 Git stage/commit/push/PR、上传、发布、部署、安装替换或 live dist-mcp 覆盖；大型 dirty worktree 原样保留。
