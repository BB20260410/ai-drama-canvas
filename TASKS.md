# TASKS · 残留任务清账 2026-07-25

## Git 研发收口（2026-07-31 23:43）

- [x] 审计全部 tracked / untracked 改动、依赖边界、凭据风险和证据引用
- [x] 提交生产冻结一致性、读纪元与确定性失败恢复：`da3bd84`
- [x] 提交总资源中心、跨项目媒体复用、原生拖出和画布保存/缩放闭环：`8a534d3`
- [x] 完成 `typecheck`、fast `188/941`、medium `90/719` 与正式 build 验证
- [x] 将 7 份无引用且已被后续版本取代的 JSON 移入可恢复隔离目录
- [x] 将验收报告、结构化证据和当前 Git 边界纳入文档提交
- [ ] 小说记忆库 P0 仍按 `.planning/2026-07-31-novel-memory-library-v1` 并行执行；完成并独立验收前不得顺带提交或清理

边界：本次仅本地提交，未 push / PR / 发布 / 部署；正式项目、CAS、raw/labeled、Review 与生产账本未因 Git 收口发生写入。

## 并行用户交付 · 总资源性能、画布媒体拖出与安装版（2026-07-28 22:56）

- [x] 修正总资源 7 个 IPC 读取通道的只读 / 缓存读取门禁
- [x] 建立图片、音频、视频跨项目进程内目录快照和稳定身份失效
- [x] 验证分类、搜索、翻页热路径不再重复扫描 27 个可读数据库
- [x] 将画布后台媒体增强任务限制为固定 4 路，并阻止刷新 / 切工程后的迟到提交
- [x] 实现图片、视频、音频从画布拖出独立复制体；源 CAS 与画布节点保留
- [x] 修复 `viewport` 保存队列竞态；跨工程 pending 隔离，切工程前强制 flush
- [x] 限制原生拖出 prepare / owned / retention 资源并完成退出清理
- [x] 修复切工程瞬态 0/0/0 投影与 `aria-busy` 就绪竞态
- [x] 完成最终 build、fast 188 files / 941 tests、隔离 Electron 与 10k 规模验收
- [x] 签名、封包并安装 `/Applications/AI 漫剧画布.app`；独立启动 / MCP / codesign / DMG 验收 PASS
- [ ] 用真人鼠标在真实 Finder / TextEdit、Preview 或另一软件完成物理落点，并核对 SHA / inode / 画布原件仍在

当前唯一未关门项：Computer Use `sky.drag` 缺少按住、分段移动和明确松键时序，Finder 只获焦但没有文件；状态为自动化工具 `blocked`，不能冒充产品 PASS，也不为迎合工具改成 `pointerdown`。

## 当前活动 Goal · 《断界桥·六相裂战》真实生图 × 无限画布共进化

- [x] 将核心北星改为：正式生图不绕开无限画布，真实问题修成通用能力后继续生产
- [x] 108 panel 独立 prompt 修复；宽银幕 panel freeze/prepare/quarantine/commit 打通
- [x] 修复 labeled 长字幕与确定性 unknown 分类/对账
- [x] 修复 panel 在 build token 轮换后的同候选 rebind、历史无 target-extension 与宽银幕复核
- [x] K12-S05 attempt 1 零二次生图完成 raw/labeled 原子 commit
- [x] 108/108 panel BindingSet current；1646/1646 proposal 已决策，stale=0、noBindingSet=0，零生图/RAW 副作用
- [ ] 逐镜闭合正式 reference envelope：上一镜、精确多视图、派生裁切、Authority 版本；正式包保持 2–5 张，代码 hard cap 为 6
- [ ] K12-S05 attempt 1 提交 Review REJECT（E-R1 比例/形状硬锁）
- [ ] K12-S05 attempt 2 correction/retry 全链 PASS
- [ ] K12-S06→K19-S04 继续串行正式生图，并用真实缺口持续完善画布
- [ ] 6 个历史 generation_unknown 全部对账清零
- [ ] 108/108 RAW、108 current Review、20/20 分镜宫格故事图、排序/连线/UI/交接关账

权威计划：`.planning/2026-07-28-dudu-six-realm-battle-completion/task_plan.md`

## 关账后用户指定交付 · 最终 MCP 候选与三单元真实连续样本（更新于 2026-07-28 03:38）

- [x] 完全退出并重开 ChatGPT/Codex 桌面应用，淘汰 app-server 缓存的旧 `db96767…` MCP 进程
- [x] 新任务只读确认运行 argv=`e9756c…`、buildId=`4575ff48…`、sourceDigest=`e9756c…`、202 tools、活动工程正确；已更新交接为 `MCP_CLIENT_RESTART_PASS`
- [x] 修复真实 readiness 热路径：请求内 schema cache、unit-grid 只读 epoch/memo、身份栅栏与损坏 marker fail-closed
- [x] 从最后源码重新建立不可变 MCP 候选 `e9756c09… / 4575ff48… / 202 tools`
- [x] 备份并切换 Codex 配置；精确停止旧候选进程；新候选 singleton 握手与单写锁身份 PASS
- [x] 重跑候选完整性、capabilities、活动工程、物理零写、drift fail-closed：5/5 PASS
- [x] 用成年阿航、神权密室、唯一完整黄金面具 D01 完成 3 个连续单元、10 个宫格
- [x] U01 attempt 1 REWORK 留痕后 attempt 2 PASS；U02/U03 attempt 1 PASS；三组 raw/labeled current 且 eligible
- [x] Codex 原尺寸检查三张 raw、三张 labeled 和 10 宫格联系表；最终视觉 PASS
- [x] 对 U03 可选 video-package 超时做只读对账：command unknown、进程已死、intent=0、无 package；未重放
- [x] 恢复原活动工程并释放样本 lease
- [x] 更新结构化视觉验收、正式报告、STATUS 和当前交接

边界：本轮未 stage/commit/push/PR，未用 Grok 生产该样本，未上传、付费、生成视频、部署或发布。

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
