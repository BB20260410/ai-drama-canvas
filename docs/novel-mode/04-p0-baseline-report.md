# 小说模式 V1：P0 基线报告

状态：`COMPLETE / P0 CLOSED`  
报告日期：2026-08-01  
对应计划：`.planning/2026-07-31-novel-memory-library-v1/task_plan.md`  
稳定源码身份：`sourceDigest=69865c673a6274552b7b018f3d2736efc0fc61409b786aba48835e3d9295d4e4`，`buildId=08b8f8168b32a84ef6ad515b00bd65fb`

结论：P0 的基线、合同、来源、许可证、FTS5、确定性规模夹具、正式样本映射、完整四分区测试和两棵保护树零写证明均已落盘并通过机器关账。P0 可以关闭并进入 P1；这只表示实施前提成立，不表示小说工作区、记忆库或最终产品已经完成。

## 1. 关账裁决

最终机器关账证据为：

- `docs/evidence/novel-mode-v1/baseline/commands/p0-close-gates-final-p0.json`
- `docs/evidence/novel-mode-v1/baseline/commands/p0-close-gates-final-p0.log`

该检查逐一重验 9 个稳定 PASS record 的退出码、命令前后 build identity、日志字节数和 SHA；解析 `test:all` 的四个分区终态；逐项比较正式小说源和活动生产工程的 before/after manifest；同时要求纠正后的构建边界记录存在。结果为 `verdict=pass`，命令前后源码摘要不变。

所有路径均以 `/Users/hxx/Documents/无限画布` 为工作区根；证据内部使用相对路径。计划、报告文字、进程仍存活或单个测试批次完成都不被当作 PASS。

## 2. 启动现场与最终现场

启动现场保存在 `docs/evidence/novel-mode-v1/baseline/environment.json`：

| 项目 | 启动值 |
|---|---|
| Git | `main`，HEAD `39bff3128451855f06182e9fd5e354ce2419ecf8`，dirty |
| 机器 | Apple M5 Max，18 logical CPUs，137,438,953,472 bytes RAM |
| 系统 | macOS 26.5.1，Darwin 25.5.0，arm64 |
| Node / Electron | Node 26.3.1；Electron 43.1.0 |
| 应用 | `ai-drama-canvas@0.2.0` |
| 启动源码身份 | `sourceDigest=7b5c3c73…a9bfa5`；886 files / 17,759,995 bytes |

P0 期间另一项已授权任务创建 `da3bd84`、`8a534d3`、`1e8e9d9` 三个提交，HEAD 前进至 `1e8e9d9c8cb055987d53b8fa0b503fb80538b3f5`。这些提交不是本 Goal 所做，P0 新增文件也未进入提交。

最终现场为 `docs/evidence/novel-mode-v1/baseline/environment-close-p0.json`：

- HEAD：`1e8e9d9c8cb055987d53b8fa0b503fb80538b3f5`
- 源码：895 files / 17,869,976 bytes
- `sourceDigest=69865c67…d9295d4e4`
- `buildId=08b8f8168b32a84ef6ad515b00bd65fb`
- Git status：46 项；1 个 tracked 生成物 `release-manifest.json`，其余为本 P0 新增且未暂存的文档、证据、脚本、夹具和测试
- 高重叠 `src/**` dirty 路径：0

本 Goal 未执行 Git 暂存、提交、推送、安装版替换、外站上传或付费操作。

## 3. 稳定基线命令

下列命令全部绑定同一 `sourceDigest=69865c67…` 和 `buildId=08b8…`：

| 命令/门 | 结果 | 决定性证据 |
|---|---|---|
| `npm run test:partitions:audit` | PASS；322 files = 192 fast / 90 medium / 35 integration / 5 heavy | `commands/partitions-audit-final-p0.json`、`.log` |
| `npm run typecheck` | PASS；exit 0 | `commands/typecheck-final-p0.json`、`.log` |
| P0 定向回归 | PASS；4 files / 19 tests | `commands/p0-directed-final-p0.json`、`.log` |
| 工作区 `npm run build` | PASS；exit 0；24,474 ms；源码身份稳定 | `commands/build-final-p0.json`、`.log` |
| 隔离源码快照 `npm run build` | PASS；exit 0；21,647 ms；live `dist-mcp` 与 manifest 前后 SHA 不变 | `commands/build-isolated-snapshot-final-p0-v2.json`、`.log` |
| `npm run test:all` | PASS；63 分 11.833 秒；322 files / 1,815 tests；四分区均 `failedBatches=[]` | `commands/test-all-final-p0.json`、`.log` |
| 六套全量规模夹具 | PASS；S1/S3/S5 各两个全新 acceptance 目录，逐文件一致 | `commands/scale-matrix-live-final-p0.json`、`.log` |
| FTS5 五 runtime | PASS；系统 Node、工作区 Electron 两模式、安装版、当前 dist | `commands/fts5-live-final-p0.json`、`.log` |
| 上游来源在线复核 | PASS；2 commits、2 trees、11 source files、2 licenses | `commands/third-party-upstream-final-p0.json`、`.log` |
| P0 机器关账 | PASS；9 个稳定 record、四分区、两棵保护树、构建边界 | `commands/p0-close-gates-final-p0.json`、`.log` |

`test-all-final-p0.json` 的通用提取器只记录第一段 Vitest 汇总 `192/960`；关账没有把它误当总数，而是直接解析完整日志中的四个 `vitest-partition-run`：

| 分区 | 文件 | 测试 | 状态 |
|---|---:|---:|---|
| fast | 192 | 960 | PASS |
| medium | 90 | 719 | PASS |
| integration | 35 | 119 | PASS |
| heavy | 5 | 17 | PASS |
| 合计 | 322 | 1,815 | PASS |

## 4. 保留的失败与构建边界事件

P0 保留失败证据，不用后来的绿灯覆盖：

1. 首次裸 build 因活动 MCP 锁冲突失败；未停止活动 writer，也未启用 multi-writer 逃生阀。
2. 一次非稳定 `test:all` 在并行 HEAD/源码变化期间出现两个 `BUILD_CURRENTNESS_MISMATCH`；不能作为稳定基线。最终已在冻结摘要上从头全绿。
3. 首次隔离快照 build 遗漏 `tsconfig.json` 和 `tsconfig.production-runs.json`，其快照少 2 files / 575 bytes，身份校验正确失败。失败 record `commands/build-isolated-snapshot-final-p0.json` 保留；完整输入的 v2 重跑通过。
4. 工作区 build 在发现前已重写 `dist-mcp/**`、`out/**` 和 tracked `release-manifest.json`。除密封 PID 40383 外，还有 PID 51269 自 7 月 29 日从可变工作区 `dist-mcp/mcp/server.js` 运行，因此无法事后证明它未发生跨构建代际动态加载。

构建事件的纠正记录为：

- `docs/evidence/novel-mode-v1/baseline/build-isolation-final-p0.json`
- `docs/evidence/novel-mode-v1/baseline/build-runtime-boundary-audit-final-p0.json`
- `docs/evidence/novel-mode-v1/baseline/change-whitelist.json`

原先错误的 `workspaceRootUnchanged=true` 与单一 writer 声明已经删除。后续阶段在 PID 51269 仍使用工作区 `dist-mcp` 时，验收 build 必须在完整源码快照中执行，并证明 live `dist-mcp` aggregate、live release manifest 和两个 PID 前后不变；不得擅自停止该进程。

## 5. 数据、权威与安全合同

以下规范已冻结并通过主审：

- `00-scope-and-authority.md`：范围、权威层、workspace mode、外部项目只读边界。
- `01-data-contracts.md`：稳定 ID、相对 locator、事实双轴、target/cutoff、证据指针、change-set 和派生库合同。
- `02-migration-and-security.md`：导入副本、迁移、路径约束、command bus/CAS、凭据、备份恢复和停止条件。
- `03-acceptance-spec.md`：P0–P8 机械门、S1/S3/S5、故障、安全、正式项目和最终 DoD。

正文与故事圣经分别由 `manuscript/` 和 `story-bible/` 持有；SQLite/FTS/摘要只能是可删除重建的派生物；AI 只能生成候选 change-set，正式写入必须经过锁、幂等键、revision/SHA CAS 和原子提交。此项只表示合同完成，业务实现属于 P1–P8。

## 6. FTS5 runtime

`fts5-live-final-p0.log` 包含五次原始 JSON：

- 系统 Node 26.3.1 / SQLite 3.53.2。
- 工作区 Electron run-as-node 43.1.0 / Node 24.18.0 / SQLite 3.53.1。
- 工作区无窗口 Electron main。
- `/Applications/AI 漫剧画布.app` runtime 只读探针。
- `dist/mac-arm64/AI 漫剧画布.app` runtime 只读探针。

五次均在 `DatabaseSync(":memory:")` 创建 FTS5 表，用参数绑定查询“嘟嘟”，只命中 `chapter-001`；项目写入和外部模型调用为 0。renderer 的小说索引健康 UI 和最终 packaged 功能闭环留给 P1/P8，不由此门冒充。

## 7. 第三方来源与许可证

在线只读复核按 `docs/third-party/novel-donors.json` 的锁定 commit 执行：

- CharacterArc：commit `c0fabfc7…`、tree `fbe1c3ad…`、5 个候选源文件和 MIT LICENSE 全匹配。
- OpenFic：commit `90f26c16…`、tree `bb402904…`、6 个候选源文件和 Apache-2.0 LICENSE 全匹配。
- 合计 13 个远端文件对象按 SHA/字节数匹配。
- `containsUpstreamImplementation=false`；当前尚未复制上游实现。
- InkOS/AGPL 只作行为规格参考，禁止复制、逐行翻译、链接或引入依赖。

后续真正采用上游实现时，必须更新 donor 状态、修改说明、NOTICE、许可证资源与 SBOM，不能沿用当前 `false` 声称已完成移植。

## 8. S1/S3/S5 确定性夹具

正式 live 复核在六个全新目录执行，生成后逐套运行 acceptance validator，再逐字节比较 `corpus.md`、`golden-answers.json`、`manifest.json`；临时目录最后可恢复地移入废纸篓。结果：

| 规模 | 章节 / UTF-16 字符 | corpus SHA | golden SHA | logical fingerprint |
|---|---:|---|---|---|
| S1 | 500 / 1,000,000 | `b91fb4408eab1a8da414d3ea819c4577894e06278c9e8d58f136f7d23b14a32d` | `ad5aefdb479d290f71e7e6279a5b71100fd271aed5a4955253f2f0a3b9b5f40a` | `487ac752061520db5cd985b9034790b2d7b5902bd53c005de19e35f1eb45e646` |
| S3 | 1,500 / 3,000,000 | `d59f01e1f392d222dc669c4fc50248b2fc444929f5515d9cd4b6f97031a4286c` | `391801381282c290cd38ff46fd2106ab9013564e217bdf6f0ccd4ced306c9250` | `cc602b9b249659370cf72bf555a1999e70fab4f74f2293911c7cd5e8b02fbf9f` |
| S5 | 2,500 / 5,000,000 | `049cc0e4a4bdce77fc498b79dcc6691e42ed763820994f6082322ad710b8c2c9` | `27a8db3c2a29a9307c90f1bd9e3e72c0b64f64d6f8e23171127fb192f2ea2e5f` | `03ca56b1405b10dfd4036618122f5376f2949f81c757d51ecd768a9118331fb0` |

每套 400 个 Oracle：100 exact、100 alias、100 state、50 future leakage、50 contradiction/candidate invalidated；覆盖 5 种 canonStatus、3 种 epistemicStatus 和 UTF-16 evidence offset。此项证明夹具合同与可复现性，不代表 P3–P5 的实际检索、时态状态或性能已经实现。

## 9. 正式项目映射与零写闭环

`03-acceptance-spec.md` 冻结 16 个正式样本 owner/path/SHA 和 32 道 CH01/CH10/CH24/CH33 金标准问题。正式项目仍必须显示：

```text
production_baseline = UNAPPROVED / USER_APPROVAL_PENDING
manuscript_status = NOT_STARTED
drafting/manuscript_gate = CLOSED
```

全树 before/after 由 `readonly-tree-comparison-final-p0.json` 机器对账：

| 保护对象 | entries / files / bytes | before = after aggregate | 结果 |
|---|---:|---|---|
| 正式小说源 | 1,353 / 1,156 / 127,886,439 | `b7afb7aa236d37f3f1654f8a1ecc1da75da2891dfdbd952714fa869c421c227c` | PASS，逐项一致 |
| 活动生产工程 | 838 / 521 / 494,157,728 | `5395f2cbc2aead35812fa0984f04e65489db91956a2fdfd2a4239903d149b0b5` | PASS，逐项一致 |

两类 manifest 均不持久化绝对源根。P0 未在正式源或活动工程创建 sidecar、索引、锁、日志、草稿或候选。

## 10. P0 退出门清单

| 退出门 | 状态 |
|---|---|
| dirty 清单、变更白名单、不允许覆盖项 | PASS |
| OS/CPU/RAM/Node/Electron/source/build identity | PASS |
| 数据、时态、路径、写入、正典和安全唯一 owner | PASS（合同） |
| CharacterArc/OpenFic 在线来源与许可证可复现 | PASS |
| InkOS AGPL 禁复制边界 | PASS |
| S1/S3/S5 同 seed 两次全量字节一致、每套 400 Oracle | PASS |
| 16 个正式 owner 映射和 32 道问题 | PASS |
| FTS5：Node、Electron main、安装版/当前 dist runtime | PASS |
| 分区审计、typecheck、P0 定向回归、build、`test:all` | PASS |
| 活动生产工程零写 | PASS |
| 正式小说原目录零写 | PASS |
| 构建边界事件披露及后续隔离路径 | PASS（有保留风险） |
| 机器关账 record | PASS |

**P0 最终裁决：完成并关闭。**

## 11. P1 入口约束

下一步只允许启动 P1“受管项目模式与小说工作区壳”，并继续遵守：

1. `drama` schema v1 继续字节兼容；缺失 `workspaceMode` 只在内存投影为 drama，不做静默迁移写入。
2. `novel|hybrid` 使用 schema v2 和最低 writer schema；旧 writer 必须在任何 sidecar/ledger 写入前拒绝。
3. 正式小说源与活动生产工程仍保持零写；P1 UI/适配器只使用合成或临时受管 fixture。
4. `MaterialStudioView.vue` 保持零 diff；App 只做窄路由补丁，小说界面懒加载。
5. PID 51269 仍使用工作区 `dist-mcp` 时，构建采用已验证的隔离源码快照路径。
6. P1 必须完成代码、定向测试、真实 Electron UI 证据和阶段报告后，才可进入 P2。
