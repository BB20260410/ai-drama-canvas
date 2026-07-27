# TASKS · 残留任务清账 2026-07-25

## 当前活动任务 · P0—P9（2026-07-27 · 已关账）

> **P0—P9 CLOSED**：最终验收见 `docs/验证报告_20260727_P0至P9生产中枢最终验收.md`。原关账轮范围为源码与隔离本机候选包，当时未安装、签名、公证、发布或执行 Git；其后经用户授权完成 Git 安全基线，仍未安装、发布或 push。

- [x] PA0 三专属代理完成产品、数据/MCP、性能/恢复审计并交换互评
- [x] PA1 形成唯一 P0—P9 执行计划与可复制 `/goal` 合同
- [x] PA2 三专属代理（产品/数据权威/性能）独立差距分析 + 交叉互评 + 主代理合并为计划 v2 修订（2026-07-26 晚）
- [x] P0 恢复当前源码/MCP身份，修只读热路径重复校验和生成入口误导（**2026-07-26 21:45 关账**）
  - [x] P0a IPC/MCP effect、TTL/singleflight、watcher 失效和真实入口文案
  - [x] P0b 活动上下文物理零写与冷暖时延定向证据
  - [x] P0c mutation epoch、stdio shutdown、错误与门禁指标真实性（双路审查闭环，MEDIUM 信号窗口已修）
  - [x] P0d 完整 fast 冻结轮 255/256+根因实证修复、隔离 build/UI、不可变候选 673a2ebe、维护切换与 5/5 live 探针
- [x] P0.5 测试分层健康化：新增 `test:medium` 与分区审计；302 files 完整分为 fast 172 / medium 90 / integration 35 / heavy 5
- [x] P0.6 mcp-process-guard 锁获取原子化：owner 临界区 + `wx` exclusive-create；真实双进程竞争仅一个 writer
- [x] P1 完成 W00—W02 最小 Authority 与十格 BindingSet（2026-07-26 22:35 关账：7 Review+Primary；10/10 generation-ready；VFX 走 style_lock 角色 + 烛龙天象按 character 建权威；镜头级 VFX 独立 owner 留 P3 收编时评估）
- [x] P2 三合一驾驶舱（ProjectionBundle + Codex active context + 当前单元画布/时间线轻投影）
  - [x] P2a 只读 ProjectionBundle core + MCP 工具 + 真实 canary
  - [x] P2b Codex 入口整合（轻入口 + 受限权威 nextAction）
  - [x] P2c 画布当前单元模式 + 时间线轻量播放子集
  - [x] P2d frozen references、raw/labeled、observation/predecessor 闭包
- [x] P3 完成 Review PASS → observed actual-tail → next freeze
- [x] P4 完成一次真实 Codex 受管生图及下一格承接（W00_G01 attempt 1 rework → attempt 2 pass）
- [x] P5 完成视频/音频 canary、时间线导入绑定播放和非 Dudu managed-evidence 视频包
- [x] P6 完成剧本存、读、图文对照、15 秒拆格产品环与 P6.5 跨工程资产复用
- [x] P7 达到首屏、首 raw、全部参考、交互、取消和 heavy 性能硬指标
- [x] P8 完成 30 分钟 soak、六阶段 SIGKILL/unknown 恢复与非 Dudu 真实工程隔离 canary
- [x] P9 完成机械、运行、视觉、性能、完整性和 302 files / 1699 tests 总验收

## 关账后授权验证 · Grok current-source live canary（2026-07-27 13:20）

- [x] 校正 Grok MCP 的过期 recorded source identity；备份原配置，doctor 复验 202 tools / handshake PASS
- [x] Grok 只读读取当前 capabilities 与活动工程：buildId/sourceDigest/currentness 与最终候选一致，正式 Dudu 零写
- [x] 全新隔离合成工程冻结、dispatch(provider=grok)，Grok Build Imagine `image_gen` 单次直调、并发 1、无重试
- [x] raw 720×1280 可解码、SHA 与 Grok 会话自证一致；本地 labeled 派生、raw/labeled 原子登记
- [x] Codex 独立原尺寸 Review PASS；scope=`synthetic-canary-contract`，不提升为正式 Dudu/黄金面具连续性 PASS
- [x] 首次 Dashboard fail-safe 降级保留；零新增生图机械回放 3/3 `ready / approved-raw-ready`
- [x] 定向回归 2 files / 11 tests PASS；证据 `docs/evidence/real-imagegen-canary-20260727-grok-current-source*`

## 关账后授权收尾 · Git 安全基线（2026-07-27 14:47）

- [x] 将 `0.2.0 / buildId 40b9cc72…` 候选完整持久化到仓库外，保存 App、辅助 ZIP、SHA 与树摘要清单
- [x] 仓库外备份旧 Git 索引/元数据以及 projects、productions、formal-calibration、runtime、docs、planning 和根证据图；内容校验零差异
- [x] 建立 4 个逻辑提交：安全纳管边界、当前源码、测试/构建身份、文档/恢复证据
- [x] 从 HEAD 全新导出后完成依赖安装、三路类型检查、正式 build、40 个关键测试、302 文件分区审计和 MCP 202 工具 smoke
- [x] fresh `out/` 与归档候选 81 文件逐内容一致，fresh `dist-mcp/` 与候选零差异
- [x] 原子同步主索引；工作树与未跟踪项均为 0；无 remote、未 push/PR
- [x] 保留约 23.83 GiB 散对象供旧索引恢复；提交自动触发的 maintenance/gc/repack 已在完成前终止，未形成 pack，3 个约 2.43 GiB 的临时垃圾文件未删除
- [x] 本地设置 `gc.auto=0`、`maintenance.auto=false` 防止再次自动打包；后续 gc/prune/临时垃圾清理须单独确认

唯一计划：`.planning/2026-07-26-production-hub-closure/next_phase_plan.md`

## 清单
- [x] T1 U25 视觉连续性 + formal PASS
- [x] T2 审片 stale → rework 通道（防死锁）
- [x] T3 Wizard demo 书面裁决
- [x] T4 NLE/视频/Grok 书面另开
- [x] T5 证据/STATUS/交接关账

## 源码生产中枢闭环 · 2026-07-26

- [x] T6 真实来源双扫描、逐文件身份核验与导入基线校正
- [x] T7 文档预览防换文件、写租约终检和多单元崩溃恢复
- [x] T8 actual-tail 观察收据、持久豁免、跨工程 activation fence
- [x] T9 VideoPackage v4 最终 CAS、journal/recovery 与 receipt CAS
- [x] T10 画布分页/局部投影/缩略图修复与运行门禁四态
- [x] T11 源码真实 UI 验收：四媒体轨、控制台、只读全树哨兵
- [x] T12 第一批性能切片：4 路来源身份核验，重型命令用例提速约 24.6%
- [x] T19 导入终态不可变完成收据、真实工程双扫重导入与篡改失败关闭
- [x] T20 门禁前置、多跳重绑恢复和 Video receipt 同事务 authority CAS
- [x] T21 异步读排空/singleflight 与 36 单元源码 dev 硬预算性能 smoke
- [x] T22 交换复审整改：项目中心双真相、跨工程 drain、多跳回拨、规模门去重假阳性
- [x] T23 Video receipt 项目 fence、完整输入闭包最终 CAS 与双竞态回归
- [x] T13 按 W00—W02 实际单元需求完成 7 项 Review/Primary；12 个未使用候选按计划保留 pending；VFX 走镜头级规则
- [x] T14 3 个连续单元、10 条 source image 轨及 video/audio 真实时间线绑定完成
- [x] T15 以真实 Review PASS 媒体完成 actual-tail → 下一镜冻结包复验
- [x] T16 通用视频包重型用例已降至约 46 秒量级并纳入 heavy 分区；heavy 最终 5 files / 15 tests PASS
- [x] T17 隔离打包端首卡稳定 5 样本 p95=854.6ms（硬门≤1500ms）
- [ ] T18 安装版维护重启：**不属于本轮源码/隔离候选包关账范围，未执行**
- [x] T24 视频发布外部输入先固化为受管 CAS；完整输入闭包与 receipt CAS/竞态回归闭合
