# TASKS · 残留任务清账 2026-07-25

## software_goal: autonomous-dev-loop-v1（无人干预开发闭环 · 2026-08-12）

- status: `completed`（当前周期关账；基础设施休眠，不再自动续跑）
- active_item: `none`；7 项全部 closed，`WORKQUEUE_EMPTY`
- earliest_next: 仅在出现新复现或用户明确要求时巡检；无票不重复全面审查
- 基础设施（已落盘）:
  - [x] 工作队列状态机 `scripts/workqueue-ops.ts`（open→claimed→verifying→closed；anti_loop≥4 自动 parked；租约 24h reap）
  - [x] 缺陷台账 `WORKQUEUE.json`（唯一工作项真相源，机器可解析）
  - [x] 巡检器 `scripts/auto-triage.ts`（`npm run patrol` / `patrol:all` / `patrol:dry`；指纹去重、复现自动重开）
  - [x] 协议文档 `docs/GOAL_无人干预开发闭环与工作队列协议_20260812.md`
  - [x] 热路径宪法 `scripts/goal-resume-prompt.txt` 升级 v3（Q0–Q4 工作队列循环）
- 已验收:
  - [x] 首轮巡检基线实跑：产出首票 wq-0001，summary 落盘 `.workqueue/`
  - [x] 完整「领取→有界修复→verify→close --evidence」自证闭环（wq-0001，复检 4/4 PASS）
  - [x] 历史记录曾登记 schedule taskId `6818847e-7575-4f68-9af0-6f575ca8a465`；当前 Codex 本地 automation registry 无该项、无运行进程，不再宣称仍在持续唤醒
- 巡检器自身首轮修复记录:
  - [x] 中文工作区路径被 percent-encode 导致日志写野目录 → 改 `fileURLToPath(import.meta.url)`
  - [x] `./workqueue-ops.ts` 后缀 import 破 `npm run typecheck` → 改 `.js` 后缀（wq-0001 销项证据 `.workqueue/verify-wq-0001-1786475986112.log`）
- 周期 2（2026-08-12 03:20–03:45）:
  - [x] wq-0002（P1）：dep-audit 探针缺 `--json` 导致 0 漏洞误报 FAIL → 补 `--json`；verify PASS 销项
  - [x] wq-0003（P2）：巡检并发写 WORKQUEUE.json 无锁 → 单飞锁（wx 独占 + 持有者探活 + 死锁接管）；`scripts/workqueue-patrol-lock-selftest.mjs` 三合同 ALL PASS 销项
  - [x] 新增 fast-tests 探针（`npm run test:fast`，P0，all/深度巡检集）；协议探针表同步
  - [x] 定时任务已自主触发巡检（证据：03:33 summary 落盘）；`auto-triage.ts` 加主模块守卫防 import 误触发
  - [x] 两套 typecheck 复检干净；queue：closed=3，open+claimed=0
- 周期 3（2026-08-12 03:50–04:17）:
  - [x] 新增探针：mcp-handshake（默认集，P0）；medium/integration-tests（深度集，P0）
  - [x] 深度巡检自主发现 wq-0004（P0）：fast 分区 4 处真实失败（255 文件中）；定时会话自主领取
  - [x] 首次多会话协调双修：定时会话改 `managed-project.ts`（ledger 断链 → storage 直导）；本会话改三处测试合同（Higgsfield 停用闸断言、ABI 重基线 270 handles/257 invokes 含 4 个已批准通道审计记录、novel 用例 120s 时限）；note 移交防竞态
  - [x] verify 全量 fast：**255 files / 1456 tests 全 PASS** → wq-0004 证据销项（`.workqueue/verify-wq-0004-1786479279968.log`）
  - [x] 协议新增「多会话协调」章（领取前查 owner/notes、mtime 冲突停手移交、单票单会话落盘源码、重负载 verify 前查重）
  - [x] queue：closed=4，open+claimed=0，本周期绿灯
- 周期 4（2026-08-12 04:20–06:30）:
  - [x] 新增探针 heavy-tests/build-full；至此四测试分区+build+类型+依赖+MCP 全覆盖
  - [x] 深度巡检自主发现 wq-0005（medium）/wq-0006（integration）；双会话分轨认领
  - [x] wq-0005 修复（本会话）：story v1 四处断言改「外层稳定摘要+cause 细节」（对齐 08-10 安全收敛，10/10 PASS）；p14 canary 确认为性能回归非死锁（无负载 72s），时限 150s；novel 401 章规划 16.3s 贴帽，时限 60s
  - [x] 队列层写竞态实测复现：wq-0007 与 wq-0005 verifying 态被并行会话读改写吞掉 → workqueue-ops 全写路径升级为 workqueue.lock 互斥+锁内重读原子写（mutateQueue），wq-0007 已恢复
  - [x] 巡检可观测性：patrol-heartbeat.json 心跳 + `workqueue-ops patrol-health`（IDLE/RUNNING/STALE/REAP-LOCK）；Q0 接入
  - [x] wq-0007 立票：P14 prepare ~72s + novel 401 章 ~16s 性能债，待性能切片拉回后收紧时限
  - [x] wq-0005 全量 medium 与 wq-0006 integration 均已复验通过并销项
  - [x] wq-0005 收尾：full-workflow E2E 无负载 ~69s 贴帽 → 时限 240s（性能债归 wq-0007）；repro 改定向矩阵（5 已知失败文件）；同 owner 重领更新 repro 能力上线；定向复验 **5 files / 34 tests 全 PASS** → 证据销项（attempts=4）
  - [x] 定时任务升级 v4：patrol-health、防双验（全机同时只允许一个重负载 verify）、队列写只走 workqueue-ops、性能超时立债票纪律
  - [x] wq-0007 三条慢链已恢复原严格门并通过正式 verify，不再停放
- 周期 5（2026-08-12 08:30–08:50）:
  - [x] wq-0007 根因分析切片：临时计时探针（orchestrator 阶段 + command-bus 三段，env 门控）实测——prepare≈50 条串行命令×~650ms：inspect+lease 17ms / exec-fence 380ms（多 SQLite CAS）/ 账本事件持久化 170ms；seedContinuity 14.9s（24 命令）与 promoteAuthorities 8.8s（15 命令）为最大耗时段
  - [x] 结论：结构性写路径成本非单点缺陷；探针全部还原（typecheck+p14 复跑 53.5s 干净）；修复三方向（连续性批量化/命令域缓存/事件同步策略）入票待专项设计评审；wq-0007 证据化停放（`.workqueue/p14-prof-result.txt`）
  - [x] wq-0006 integration 第三轮 verify（无负载窗口）**PASS** 并证据销项（`.workqueue/verify-wq-0006-1786495823596.log`，attempts=3）；前两轮失败均为外因：轮 1=BUILD_CURRENTNESS_MISMATCH 门禁 fail-closed（当时源码漂移）+mcp-managed-studio 撞 30s 帽；轮 2=与 wq-0005 verify 互撞致 mcp-scan-cancel 负载 flake（隔离复跑 PASS）
  - [x] scheduled-patrol 本会话有界修复清单：`tests/fixtures/mcp-tool-abi.json` 重基线 9d8b96cc（220 工具无增删名，fixture 早于 tool-registrar 重构的合法漂移）；`tests/mcp-managed-studio.test.ts` 时限 30→120s（空载实测 24.5s）；`scripts/workqueue-ops.ts` verify 帽 20→45min；`scripts/auto-triage.ts` integration 探针帽 30→45min；临时诊断脚本已全部清理
- 周期 6（2026-08-12 15:30–16:31，最终收尾）:
  - [x] 中断前 fast **255 files / 1456 tests**、medium **91 files / 801 tests**、integration **36 files / 123 tests** 已完整 PASS；仅补跑丢失汇总的 heavy 后 3 批，最终 heavy **5 files / 17 tests** 全 PASS
  - [x] P14 主链空载实测 47.8s（此前 53.5s），恢复 60s 严格门；小说 401 章恢复 20s；full-workflow 恢复 120s
  - [x] wq-0007 经正式状态机 reopen→claim→verify→close；3 files / 8 tests PASS，证据 `.workqueue/verify-wq-0007-1786523422811.log`
  - [x] 队列终态 `closed=7`，无 parked/open/claimed；`patrol-health=IDLE`、`WORKQUEUE_EMPTY`
  - [x] 项目 App/MCP/Vitest/巡检进程全部收口；没有用宽泛 `killall node`
  - [x] 新增 `docs/给其他AI_全面优化审查与强健化执行提示词.md`，固定证据驱动、单 writer、两轮纠正上限和完整质量门
- 交接（2026-08-12 08:52，用户额度耗尽）:
  - 历史交接已被周期 6 取代；当前队列 closed=7，无待办
  - 后续仅在新复现时运行 patrol；不得重新停放或重开 wq-0007
  - 多会话纪律（本周期实测）：重负载 verify 前必查重（防双验）；同票单会话落盘源码；状态迁移丢失用 `reopen --why` 恢复；队列写只走 workqueue-ops（workqueue.lock 互斥）
- boundaries: 巡检只读；修复有界切片不扩域；不重建 P0–P14 owner；不付费/Git 写/公证/发布

本周期已经完成。新目标启动时才读取本节并按需运行 `npm run workqueue:next`；不得把空队列当成继续全面审查的理由，也不得重建四件套。

## software_goal: bounded-improvement-local-delivery-20260811

- status: `completed`
- active_item: `none`
- earliest_next: `none`：无新复现不得重跑 candidate/package/install
- plan: `.planning/2026-08-11-untitled-71abd207/task_plan.md`
- selected_items:
  - [x] connector authorize 与 formal call-intent/result/bundle/not-invoked/abandon/fail/cancel/retry 在同一写事务内互斥；3 files/20 tests、两套 typecheck、独立终审 CLEAN
  - [x] generation ledger watcher 单 drain；50 次触发最多当前轮+最新补轮；错误只补一轮；close 等待且关闭后零发送；6/6 与独立终审 CLEAN
  - [x] VideoEditor 1000 nested clips 只选择优先/可见需求；打开不等待；running 旧 key 与切根旧结果零回填
  - [x] VideoEditor hover 有界单飞；两域共用物理并发 2；root/scan/filter/page/query/unmount 失效；foreground 媒体任务不被预览抢占
  - [x] 定向与相邻回归、两套 typecheck、official production audit、diff check、独立终审；P0/P1/P2=0
  - [x] remote terminal 与同一 formal run 保持绑定；`claimed` 可被 formal terminal 抢先；bundle 在 raw/labeled/CAS/receipt 前零写拒绝
  - [x] hover latest-demand；foreground 先清 queue、等最多2个在途任务，并由引用计数最后释放才恢复
  - [x] 对 `954ac71a…` 执行唯一 build并冻结 `c7cb5cee… / 220 tools`
  - [x] 冻结新身份并只做一次 candidate/current/stdio 与一次后台隔离 package smoke；current invalid=0、stdio `220/89/9/8`、两阶段 terminal PASS
  - [x] Developer ID local-only 可回滚安装与唯一隐藏 installed verify；show/focus=0、547ms 自然退出、App 已关闭
  - [x] 新证据、验收报告、STATUS/TASKS/当前交接关账
- correction_rule:
  - 每切片最多两轮同范围纠正；红测→实现绿灯不计纠正轮
  - 同一失败不原样重跑；长命令只轮询同一进程
  - candidate/package/installed verify 各一轮正式新身份；源码修改后旧交付身份作废
- boundaries: 不重建 P0–P14 owner；不改正式数据；不调用外部生成/上传/付费；不公证/发布；不 Git stage/commit/push；不重跑 fast/medium/T23
- installed_app: `/Applications/AI 漫剧画布.app` = `954ac71a… / c7cb5cee… / 220`，Developer ID arm64，隐藏验收 PASS
- rollback: `/Users/hxx/Documents/无限画布_交付归档/local-install-20260811T135947Z-954ac71a`，旧 d5 installed/dist 可恢复
- evidence:
  - `docs/evidence/bounded-improvement-local-install-final-20260811-954ac71a.json`
  - `docs/evidence/isolated-package-smoke-20260811T135145Z-954ac71a-completion.json`
  - `docs/evidence/installed-local-verify-20260811T135947Z-954ac71a.json`
  - `docs/验证报告_20260811_有界改良与本机安装闭环_954ac71a.md`

恢复时只读取本区块 `earliest_next`；不得从 Phase 1 或全面审查重新开始。

## software_goal: bounded-maintenance-four-slices-20260811

- status: `completed`
- active_item: `none`
- earliest_next: `none`；如需让安装版跟随最新源码，另开 local-only 交付任务
- completed_items:
  - [x] Review history 独立 latest-only gate，旧成功/失败与卸载后请求均不能回填
  - [x] Projection canonical asset 单请求 Promise cache，并发 4、顺序/fingerprint 不变
  - [x] candidate/isolated 共用 npm 生产依赖语义门；节点 flags、真实路径、lock resolution、版本与 prerelease 失败关闭
  - [x] SQLite raw busy 禁止自动重放；typed proof 才重试；登记直接落 `executing`
  - [x] command/backup 使用统一 5 秒 absolute deadline；真实 writer lock 有界失败且 staging 清零
  - [x] 7 files / 37 tests、邻接 4 files / 58 tests、两套 typecheck、build、audit 0、diff check PASS
  - [x] 独立终审 CLEAN：P0=0、P1=0、P2=0
- boundaries: 未运行 T23/candidate/package/install；未打开 App；正式数据/外部调用/上传/付费/Git 写操作为 0
- installed_app: `d5ce49a9… / 6ed09cc9… / 220`，稳定但不是 `4cffddd6…` 最新源码
- evidence:
  - `docs/evidence/bounded-maintenance-four-slices-20260811-4cffddd6.json`
  - `docs/验证报告_20260811_四项有界优化整改_4cffddd6.md`

恢复时只读取本区块 `earliest_next`；不得自动重复审查或交付链。

## software_goal: runtime-stability-local-delivery-d5

- status: `completed`
- active_item: `none`
- earliest_next: `none`：无新复现不得重跑交付链；candidate/归档空间清理需另开审计，不得盲删
- completed_items:
  - [x] 冻结 `d5ce49a9… / 6ed09cc9… / 220`，官方 registry 生产依赖审计 0
  - [x] 构建并原子发布 immutable candidate；current check 16 candidates / invalid 0
  - [x] 真实 stdio initialize + tools/resources/prompts：`220 / 9 / 8`
  - [x] 唯一隐藏隔离 package smoke：lockfile npm ci、空工程恢复、Effect/Transition、ReviewStudio 全 PASS
  - [x] 构建 Developer ID arm64 目录包；不生成 DMG、不公证
  - [x] 保存旧 dist 与旧 c9 安装版，验签后可恢复切换 `/Applications/AI 漫剧画布.app`
  - [x] 安装版隐藏验收：App 自带 Electron runtime、220 tools、show/focus=0、52ms 自然退出
  - [x] 额外旧 `/Applications/本地画布.app` 0.1.0 移入废纸篓，未永久删除
  - [x] 落盘结构化证据、报告、STATUS、TASKS 与当前交接
- boundaries: local-only；不公证/发布/上传/付费/正式数据写入；未 Git stage/commit/push；App 已关闭
- evidence:
  - `docs/evidence/runtime-stability-local-install-final-20260811-d5ce49a9.json`
  - `docs/evidence/isolated-package-smoke-20260811T084933Z-d5ce49a9-completion.json`
  - `docs/evidence/installed-local-verify-20260811T085603Z-d5ce49a9.json`
  - `docs/验证报告_20260811_严格性能版本本机安装闭环_d5ce49a9.md`

## software_goal: runtime-stability-refactor-v1

- status: `completed`
- active_item: `none`（`d5ce49a9…` 已做唯一隐藏 strict 终验并 PASS，禁止无新复现重跑）
- earliest_next: `none`：严格性能 Goal 与独立本机交付均已关账
- completed_items:
  - [x] 小说分析任务路径/绑定 P1：confined/no-replace 路径、锁内 immutable binding 复验、软链与 TOCTOU 零 POST
  - [x] Higgsfield 自证明授权 P1：不可信 MCP capability/zero-credit 声明不再具有外部调用授权效力
  - [x] VideoEditor 媒体服务端分页、有界快照查询缓存、游标身份和 root/scan/sequence 迟到回填门禁
  - [x] Projection bundle 重复深查询去重；确定性夹具 Core `2945.26 → 2401.39ms`，panel `1404.70 → 1049.18ms`
  - [x] 默认关闭的阶段时间线、latest-attempt 探针与 T23 精确进程/临时目录收口
  - [x] Dashboard 单请求 Schema 深验复用；每个顶层请求独立 epoch，不缓存连接/业务结果
  - [x] 首卡改为真实单元节点 DOM 插入里程碑；纯展示 build identity 移出首卡关键路径
  - [x] 默认 Canvas 在 units ready 前禁止 Canvas/Material Overview；Canvas Overview ready 后才启动 raw 与 Material Overview
  - [x] 建立一次性 Overview 释放门、managed shell 启动复用和仅短剧工作区受管模块预热
  - [x] T23 建立 36 个单元、4 个 deep-verified raw、4 个 reference 的逐单元精确映射合同与定向测试；严格运行因首卡超时未执行到后续 assertion
  - [x] 关闭 startup manifest 缺失 fail-open、恢复 validation 残留和启动对账重复 activation fence；独立终审 CLEAN
  - [x] units exact-query 预取仅在 startup reconcile 成功后启动；in-flight coalescer 成功/失败均释放且不缓存结果
  - [x] 建立 latest raw/reference span 与同 Renderer 原子 timeline/IPC/hook/raw 取证，严格拒绝 reload、旧 span 回退和跨文档拼接
  - [x] Playwright 页面函数改为原生 `.mjs` 函数对象；`script-src 'self'` headless Chromium CSP canary PASS
  - [x] 本切片影响范围 11 files / 99 tests、两套 typecheck、build、限定 diff check与独立只读复核 PASS
  - [x] 新切片定向 6 files / 71 tests、两套 typecheck、build 与限定 diff check PASS
  - [x] 最终有界矩阵 17 files / 178、相邻 6/31、探针清理 2/21、画布顺序 1/37 均 PASS
  - [x] 两套 typecheck、build、official production audit 0、diff check、独立终审完成
  - [x] `PERF-UNITS-READ-HOTPATH-01`：新增请求级匿名阶段/连接/查询取证；36 单元 `request-total=42.06ms`，证明当前 units 已非严格门瓶颈
  - [x] T23 成功/失败证据使用白名单投影，移除缩略图 URL、页面 URL/正文与原始异常；路径脱敏红绿测试通过
  - [x] 新身份 `d5ce49a9… / 6ed09cc9… / 220` 唯一 hidden strict+interactions：首卡 1246、首 raw 4033、全参考 5201、IPC4，全部 PASS
- deferred_items:
  - Preload units phase 名防御性白名单（producer 已由固定联合类型约束；不阻断当前 Goal）
  - T23 启动极早期 console/page error 监听 P2（独立测试基础设施切片，不在本性能切片扩域）
  - 替代/最小 preload 兼容残差：gate API 存在性仍连带要求 identity API；正式 preload 不受影响
  - GlobalResource hidden harness 默认证据名并发 no-clobber P2
  - 本轮未选中的其他 P2/P3
- blockers: `none`
- evidence:
  - `docs/evidence/runtime-stability-refactor-bounded-closeout-20260811-f1b48f4a.json`
  - `docs/evidence/runtime-stability-t23-phases-final-20260811T021900Z-f5fee3b7.json`
  - `docs/evidence/runtime-stability-t23-phases-correction-final-20260811T022806Z-f1b48f4a.json`
  - `docs/验证报告_20260811_运行速度稳定性安全边界有界整改_性能阻塞收尾.md`
  - `docs/evidence/runtime-stability-t23-cold-start-diagnostic-20260811-a74b9b04.json`
  - `docs/evidence/runtime-stability-t23-cold-start-final-20260811-98c00560.json`
  - `docs/验证报告_20260811_冷启动细分与请求缓存有界整改.md`
  - `docs/evidence/runtime-stability-t23-cold-start-overview-order-final-20260811-16f76296.json`
  - `docs/验证报告_20260811_冷启动Overview排序有界实施与严格复验.md`
  - `docs/evidence/runtime-stability-t23-build-strict-final-20260811-1d984598.json`
  - `docs/验证报告_20260811_冷启动最终严格终验_1d984598.md`
  - `docs/evidence/runtime-stability-t23-strict-final-redacted-20260811-d5ce49a9.json`
  - `docs/验证报告_20260811_units只读热路径取证与严格性能关账_d5ce49a9.md`
  - `docs/evidence/runtime-stability-local-install-final-20260811-d5ce49a9.json`
- correction_round: `units_probe=1`；`evidence_redaction=1`；新身份 strict 只运行一次
- completion_gate:
  - [x] known_p0 = 0
  - [x] selected_p1 = 0
  - [x] selected_performance_items = completed
  - [x] targeted_tests = 5 files / 50 tests pass；units/T23 相邻定向矩阵 pass
  - [x] adjacent_tests = pass
  - [x] typecheck = pass
  - [x] typecheck_app = pass
  - [x] build = pass
  - [x] diff_check = pass
  - [x] final_review = clean；P0/P1/P2=0（限本 Goal）
  - [x] strict_t23 = pass（1246 / 4033 / 5201ms；IPC4；interactions PASS）
  - [x] evidence_redaction = pass
  - [x] package_smoke = pass（独立交付 Goal 唯一隐藏运行）
  - [x] installed_app_identity = current source（d5ce49a9… / 6ed09cc9… / 220）
  - [x] installed_hidden_verify = pass（show/focus=0，52ms 自然退出）
  - [x] formal_data_untouched = yes
  - [x] external_paid_calls = 0
  - [x] git_stage_commit_push = 0
  - [x] app_closed = yes
  - [x] evidence_index = nonempty
  - [x] STATUS/TASKS = updated

恢复时只读取本区块 `earliest_next`。本 Goal 与本机交付均已完成，不得自动恢复或重复 T23/candidate/package/install；只有新复现才开启有界切片。

## software_goal: whole-project-behavior-preserving-refactor-v1

- status: `completed`
- active_item: `none`
- roadmap: `docs/全项目行为保持重构路线图_20260810.md`
- completed_items:
  - [x] 全项目机械盘点：315 个源码文件、约 220,715 行 TS/Vue、最大 owner/入口与运行时 SCC
  - [x] 并行完成 Core、Electron/MCP/交付、Renderer/UI 三域只读架构审计
  - [x] 抽取 Higgsfield 纯 connector 合同，保留兼容导出并解除两节点运行时循环
  - [x] 将 `NovelWorkspaceSnapshot` 归入 `novel-types`，移除写作模块对仓库实现的反向类型依赖
  - [x] 向导资产读取抽为纯 helper，去重保序且并发上限 4
  - [x] 受管画布普通/固定文稿读取并发上限 4，保留 root/sequence 与失败行为
  - [x] Phase A：13 个唯一测试文件 / 137 项、两套 typecheck、diff check、独立终审 CLEAN
  - [x] Phase B：8 个 owner 统一 canonical JSON；10 files / 136 + boundary 2 files / 5；字节向量与 P24 golden 不变
  - [x] Phase C：显式 MCP registrar；220 工具 ABI、87 guarded map、effect/gate 与调用顺序保持
  - [x] Phase D：v7 ledger storage/contract 分层；9 个 DDL/迁移函数字节不变；Active Studio SCC 解除
  - [x] Phase E：28 个公共类型、只读 mapper 与旧画布纯投影分层；9 files / 69 + main 6 / 23
  - [x] Phase F：58 条 Studio executor 与可靠性壳分层；7 条 global resource read IPC；ABI 不变
  - [x] Phase G：candidate stage/cutover 与两阶段 terminal evidence；post-fix 终审 CLEAN
  - [x] Phase H：同一 `c9bb2c87…` 源码身份完成 build、candidate、stdio 与隐藏隔离 package smoke
  - [x] 最终独立终审：技术链 CLEAN；关账字段矛盾修复后 P0/P1/P2=0
  - [x] 本机安装：`c9bb2c87… / 02a1bf9d… / 220 tools`，Developer ID、隐藏启动与自然退出 PASS
- pending_items: `none`
- correction_rule: 每切片最多两轮同范围纠正；失败即记录 blocker，不从头重跑全量
- boundaries: 不重建 P0–P14 owner；不改正式数据；未执行付费/上传/公证/Git stage/commit/push；App 已关闭

## 运行速度、稳定性与安全边界有界整改（2026-08-10 22:12）

- [x] 完成 Provider DNS pin、公网 HTTPS、TLS/代理/重定向及全错误投影安全边界
- [x] 完成 5 条用户路径的隐藏基线：导航、T23 画布、总资源、剪辑台、规模工程切换
- [x] 将投影 IPC 峰值从 5 降为 3
- [x] 将同节点选择与展开从 10126.97ms 降为 8648.52ms
- [x] 回退没有稳定收益的 units-first 首卡尝试
- [x] 完成 Provider 63、command bus 17、两套 typecheck、build、diff、audit 0 与独立终审
- [x] 完成唯一 candidate 与唯一 package smoke；4 次隐藏启动自然退出且无残留
- [x] 构建 Developer ID arm64 local-only App，可恢复替换 `/Applications/AI 漫剧画布.app`
- [x] 安装版隐藏验收：220 tools、show/focus=0、49ms 自然退出、App 已关闭
- [ ] 首卡 `≤1500ms`：最终 2094ms，已按两轮上限冻结为 blocker

不得把本节标为全部完成；唯一未通过的 completion gate 是 selected performance 的首卡预算。

## 小说分析 Provider 出站安全重构（2026-08-10 20:58）

- [x] 建立单次 DNS 地址快照并将校验结果绑定到真实 Undici 连接
- [x] 关闭公网 HTTP 明文外发；仅保留显式授权且全地址非公网的本机/私网 HTTP
- [x] 完整覆盖 IPv4、IPv6、映射地址、site-local、link-local、CGNAT 与保留空间
- [x] 保持原 Host/SNI，显式强制 TLS 证书校验，拒绝宿主环境降级
- [x] 禁止环境代理与重定向；成功、超时、超限和异常均收口独立 Agent
- [x] URL/DNS/协议/凭据门禁移到 execution intent 前；保持 dispatch 后 submission_unknown 合同
- [x] 清理远端响应回显与内部路径落盘，任务/事件只保存稳定安全摘要
- [x] 将 Undici 提升为精确直接生产依赖，并从有高危公告的 7.28.0 校正为 7.29.0
- [x] 完成 3 files / 56 tests、两套 typecheck、build、依赖审计、产物旧字符串和 diff 门禁
- [x] 完成独立 Max 安全终审并落盘报告、结构化证据、STATUS 与交接

本切片无剩余源码任务。按既定边界未构建 candidate、未打包或替换 App；只有用户明确要求安装新版时才开启独立交付切片。

## 全面 UI/功能/稳定性/性能复验与本机更新（2026-08-10 19:39）

- [x] 审计 359 个测试文件和 39 个 Vue 页面；建立 547 按钮、图片、音视频静态合同
- [x] 完成 medium 91/788、integration 35/119、heavy 5/17；关闭 fast 首轮 4 个失败并完成最终 6 files / 71 tests 定向复验
- [x] 修复生成队列统计截断、Vue Flow 无名按钮/重复 ID、缩略图不可选中、图标按钮与媒体解码缺口
- [x] 为高密度列表增加离屏内容剔除与固有尺寸占位，保持分页/虚拟化/异步 token 合同
- [x] 隐藏执行 22 条 UI 路径、6 类节点动作、总资源/时间线/图文对照/备份恢复取消/项目焦点与未保存门禁
- [x] 实测 1288 单元、4235 宫格、77 资产、10000 媒体及 10 次跨工程切换；无串库、FD +0、RSS 无增长
- [x] 构建并校验 immutable candidate：220 tools、13 candidates / invalid 0
- [x] 唯一隔离 App smoke：4 次自然退出、零 show/focus/强杀/残留；剪辑和审片重启恢复 PASS
- [x] 构建 Developer ID arm64 App、替换 `/Applications/AI 漫剧画布.app` 并完成隐藏安装验收
- [x] 历史当时删除旧 `/Applications/本地画布.app` 0.1.0 与 DMG/blockmap；2026-08-11 再次发现同 bundle ID 旧版后已移入废纸篓，可恢复
- [x] 落盘总证据、验收报告、STATUS 与交接；未公证、发布或 Git stage/commit/push

本任务无剩余项。不得为追求“全按钮物理点击”而执行删除、上传、付费或正式生产副作用；出现新复现时只开对应有界切片。

## 最新 App 保持与旧构建清理（2026-08-10 17:12）

- [x] 核对 `/Applications` 当前 App 与 `dist/mac-arm64` 最新产物的 release manifest、`app.asar` SHA 和 Developer ID 签名
- [x] 只读挂载 `dist` DMG，确认其为 `265498ff…` / 218 tools 的旧构建而非当前 220-tool App
- [x] 精确清理 9 个旧 App、4 个旧 DMG、5 个旧 blockmap，共 18 项 / 约 3.96 GiB
- [x] 所有旧产物移入独立废纸篓目录，未永久删除，保留恢复能力
- [x] 复核受检路径旧 App 与安装包均为 0；当前安装版保持关闭且签名有效
- [x] 落盘结构化证据并更新 STATUS 与当前交接

本任务无剩余项。不要重建、重装或重新跑 package smoke；当前安装版已经是最新版。若要永久释放空间，由用户自行清空废纸篓。

## 性能可靠性修复与本机安装最终闭环（2026-08-10 15:42）

- [x] 复现并确认 Electron 43.1.0 npm 包不再自动下载 binary
- [x] 显式运行 lockfile `install-electron`，增加官方缓存 checksum、四方版本、arm64、权限与 ZIP 布局门禁
- [x] 新增无窗口 provenance fixture，完成 ZIP 解包前后 executable SHA 复验
- [x] 定向 2 files / 16 tests、两套 typecheck、diff check PASS
- [x] 唯一最终 `package:isolated-smoke` PASS；4 次 packaged App 自然退出，零 show/focus/Dock，零残留
- [x] 构建并切换最终 220-tool immutable candidate，12 publications / invalid 0
- [x] 构建 Developer ID arm64 local-only App，不生成 DMG、不公证
- [x] 可回滚替换 `/Applications/AI 漫剧画布.app`，新旧 App deep/strict 均 PASS
- [x] 安装版 bundled MCP 220 tools 与后台 47ms 自然关闭验收 PASS
- [x] 落盘最终报告、证据、STATUS 与交接；App 保持关闭

本任务无剩余项，不得再重跑 fast/medium、candidate、package smoke 或安装；只有新的可复现缺陷才开新切片。

## 运行性能与可靠性有界修复（2026-08-10 13:20）

- [x] 冻结前次审查基线与本轮 14 项问题，不扩域重建既有 owner
- [x] 修复 Higgsfield 队列租约恢复、远端终态、unknown 人工对账、owner currentness 与过期预检错误归类
- [x] 修复剪辑台大时长、全量 DOM/deep watch、嵌套预览并发和热路径查找
- [x] 修复受管画布缩略图并发、节点 A→B 竞态、素材库隐藏首屏加载与旧画布主要 O(n²) 扫描
- [x] 修复总资源瞬时 SQLite 错误缓存与小说 FTS 热查询全章串行 stat
- [x] 将隔离包改为 lockfile `npm ci`，补直接生产依赖多方身份审计与可重复 production audit
- [x] 完成定向测试、影响范围复验、两套 typecheck、工作区 build、audit 0、diff check与最终 220-tool candidate
- [x] **原 BLOCKED_LOCAL_PACKAGING 已关闭**：无窗口 fixture、唯一最终 smoke 与本机安装均 PASS；终态见上节
- [x] Electron binary 下载/缓存/provenance 及一次性 package smoke 已完成

禁止从 fast/medium 全量重新开始；禁止在本切片继续第 4 次 package smoke。详见 `docs/验证报告_20260810_运行性能与可靠性有界修复.md`。

## 无限画布首屏分包性能优化（2026-08-10 10:42）

- [x] 记录改前 renderer 主包字节、gzip、SHA 与全部 JS 总量
- [x] 将旧版 VueFlow core、background、controls 改为只在旧画布挂载时动态加载
- [x] 将 Production/Zone/Inspector/Note/Group/Narrative 六个旧画布组件拆出首屏主包
- [x] 用 `pane-ready` 保存实际 VueFlow store，并为未挂载时的诊断缩放、视口和节点聚焦提供安全退路
- [x] 新增懒加载回归门禁，并完成小说路由、剪辑未保存门禁、受管画布相邻复验：4 files / 42 tests PASS
- [x] 只做一次无窗口正式构建，确认主 JS 减少 45.84%、gzip 减少 43.91%，HTML 不静态预加载 VueFlow
- [x] 落盘结构化证据、验收报告、STATUS 与当前交接

本切片已经关账，不从 fast/medium 全量测试重新开始。`/Applications/AI 漫剧画布.app` 仍是上一个已安装版本；只有用户明确要求安装本次性能版本时，才另做一次有界打包、替换和安装后验收。

## Higgsfield 画布图片/视频排队桥（2026-08-10 07:55）

- [x] 在正式图片 generation run 与受管视频 package 上增加画布内 Higgsfield 排队入口
- [x] 在既有 generation ledger 中实现图片/视频统一请求、Codex claim、请求绑定免费预检、一次性 authorize 与 submission receipt
- [x] 新增只读 MCP `get_studio_connector_work_queue`，并把其他 Codex 窗口的固定消费顺序写入项目 Skill
- [x] 锁定图片 `gpt_image_2 / 1k / low` 与视频 `seedance_2_5 / References / 20s / 720p / audio`，全部 `use_unlim=true`
- [x] 关闭 paid fallback、旧 owner 重复提交、未知态重提、过期 nonce、绝对路径普通投影、claim/nonce 命令账本泄漏和敏感回执落盘
- [x] 完成 8 files / 48 tests、两套 typecheck、diff check、最终 220-tool candidate、真实 stdio 握手和唯一隐藏隔离 App smoke
- [x] 可回滚安装 `/Applications/AI 漫剧画布.app`；Developer ID deep/strict、后台零 show/focus、自然退出均通过；未公证
- [ ] **BLOCKED_BY_PROVIDER**：等待 Higgsfield 对当前账户与具体图片/视频模型返回可验证的 Unlimited 零扣费能力
- [ ] **后续独立切片**：拿到真实 jobId 后实现 poll、下载、媒体校验、CAS、视频 0–15 秒时间线绑定与图片/视频 Review 回写

当前不能通过继续重复构建、测试或伪造 `zeroCredits=true` 解除阻塞；禁止用普通积分队列、网页自动化或重复提交冒充 Unlimited。

## Higgsfield Ultra 会员 Unlimited 程序化复核（2026-08-10 06:58）

- [x] 确认 Connector、CLI 与唯一 workspace 均为 Ultra，排除错账号/错工作区/授权过期
- [x] 将官方 CLI 从 1.1.20 更新到 npm 当前 1.1.23，并复核 `use_unlim` 合同
- [x] 对 4 个图片、5 个目录标记视频模型与 Seedance 2.5 做一次性零副作用 cost matrix
- [x] 确认当前没有 cost=0、Unlimited billing receipt 或可通过的视频 Unlimited 预检
- [x] 保持生成=0、上传=0、credits 消耗=0，不用普通 credits 或网页自动化冒充完成
- [ ] **BLOCKED_BY_PROVIDER**：等待 Higgsfield 将网页 Ultra Unlimited 权益开放到 connector/API/CLI，并为具体图片与视频模型返回可验证免费回执

本阻塞不能通过继续改本地代码或重复试扣解决。证据：`docs/evidence/higgsfield-unlimited-membership-programmatic-recheck-20260810.json`。

## Higgsfield Seedance 2.5 Unlimited 软件桥（2026-08-10 06:48）

- [x] 复核并收尾上一轮代码审查、candidate、隐藏 smoke 与本机安装
- [x] 用真实 Higgsfield connector 核对账户 entitlement、Seedance 2.5 model capability 与 `use_unlim:true` cost gate
- [x] 冻结 References / 20 秒 / 720P / Audio On / Unlimited-only / 并发 1 参数，禁止普通 130 credits 队列回退
- [x] 在既有 generation ledger 上实现 Codex-only capability attestation、prepare 与 submission receipt；不建平行数据库/CAS
- [x] 补齐活动工程 fence、Studio 写租约、受控参考路径、一次性调用许可、unknown 防重和远端敏感字段脱敏
- [x] 接入 Main/preload/Renderer 动态只读控制面；Unavailable 时明确阻断且无 UI 提交旁路
- [x] 完成 4 files / 21 tests、两套 typecheck、diff check、独立终审 CLEAN
- [x] 构建最终 candidate 并通过 current 与真实 219-tool MCP 握手
- [x] 完成唯一一次后台隐藏隔离 App smoke、Developer ID 本机包、可回滚安装与安装版独立验收
- [ ] **BLOCKED_BY_PROVIDER**：Higgsfield 同时返回 `unlim_available=true` 与 Seedance 2.5 `supports_unlim=true` 后，只提交一次隔离 canary
- [ ] **后续独立切片**：基于真实 jobId 实现/验收 poll、下载、20 秒 720P 解码、CAS/Publication 与 0–15 秒时间线绑定

当前没有可通过重复测试或网页自动化解决的本地阻塞。不得用 130 credits 普通队列、网页私有请求或重复提交冒充 Unlimited；供应方能力未变化前不重跑本任务。

## 再次代码审查、修复与本机安装闭环（2026-08-10 05:58）

- [x] 与 2026-08-09 全面审查逐项比较：CORE/UI/PERF/MCP/DEP 共 9 项均保持修复
- [x] 修复活动工程注销绕过 paid-call activation fence 的 P1
- [x] 修复启动早期 close request 在 preload/renderer ready 前丢失的 P1
- [x] 修复安装验收证据目标可落入签名 App 包内或经 symlink 逃逸的 P1
- [x] 修复 VideoEditor 异步 session 泄漏、recoverable 退化 reopen、SDK 精确身份、安装验收后台有界关闭 4 个 P2
- [x] 完成影响范围复验：8 files / 65 tests、两套 typecheck、diff check 均 PASS
- [x] 只构建一次最终 candidate，并完成 current 校验和真实 MCP initialize/tools/list 握手
- [x] 只运行一次隔离 App smoke：4 次自然 exit 0，8 份后台快照无 show/focus/Dock，零残留进程
- [x] 构建 Developer ID 签名 App、可恢复替换 `/Applications` 安装版，并完成安装后后台独立验证
- [x] 落盘对比报告、结构化证据、STATUS 与当前交接

当前代码审查切片无剩余任务。不要重新从 fast/medium/integration/heavy 全量分区开始，也不要重复构建 candidate、隔离 smoke 或安装；后续仅在出现新的可复现问题或用户明确开启新目标时进入下一切片。

## 本机安装与真实拖出最终收口（2026-08-10 05:16）

- [x] 修复 ReviewStudio close ACK 交付竞态与窗口销毁后访问 `webContents` 的异常
- [x] 图片、视频、音频真实拖到 Finder；图片真实拖到独立 AppKit 接收器；复制体与源保留合同通过
- [x] 构建并验证最终 MCP candidate：218 tools、current `ok=true`、invalid 0、真实 SDK 握手 PASS
- [x] 完成最终隐藏隔离 App smoke：两套 UI 各两次自然 exit 0，show/focus/Dock 门禁全部通过
- [x] 备份旧安装版并将当前验收 App 安装到 `/Applications/AI 漫剧画布.app`
- [x] 安装版独立验证：Developer ID deep/strict、arm64、App 自带 Electron、MCP 218 tools、隐藏首启 PASS
- [x] 明确本机 local-only：不公证、不上传、不发布、不生成新 DMG

当前 App/拖出切片无剩余任务。小说工作区与《断界桥》正式生图是独立目标，继续前先读各自最新计划和实时工程状态，不能因本节完成而自动推进。

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
- [x] 用真实 macOS 按住/分段移动/松开完成 Finder 与另一原生 App 物理落点，并核对 SHA / inode / 画布原件仍在（2026-08-10 PASS）

历史 `sky.drag` 阻塞已由 `/opt/homebrew/bin/cliclick` 的真实 `dd → dm → du` 系统拖拽和独立 AppKit 接收器验收接替；最终证据为 `docs/evidence/native-media-drag-physical-20260809T202248842Z-40022*.json`。旧失败证据保留为历史，不再是当前阻塞。

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
- [x] T18 安装版维护更新：2026-08-10 将 sourceDigest `a4312c76…` / buildId `e0197b69…` / 218 tools 的当前 App 安装到 `/Applications`，旧版已归档；本机 local-only，不公证
- [x] T24 视频发布外部输入先固化为受管 CAS；完整输入闭包与 receipt CAS/竞态回归闭合
