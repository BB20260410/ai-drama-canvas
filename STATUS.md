# STATUS · 当前源码生产中枢（P0—P9 CLOSED / MCP_CLIENT_RESTART_PASS）

## 2026-07-31 23:43 · Git 研发收口（软件增量已提交）

| 字段 | 当前事实 |
|---|---|
| 结论 | **已完成（既有软件研发改动范围）**：生产可靠性与总资源/画布闭环已拆成两个可审计提交；过时中间证据已可恢复隔离 |
| 提交一 | `da3bd84` · `fix(studio): 固化生成冻结一致性并收敛失败恢复` |
| 提交二 | `8a534d3` · `feat(studio): 交付总资源中心与画布媒体复用闭环` |
| 验证 | `typecheck` PASS；fast `188 files / 941 tests` PASS；medium `90 files / 719 tests` PASS；build PASS，buildId `38dbb556ec8ff28a7e669ba2e72b8e8b`，MCP `202 tools` |
| 清理 | 7 份无报告引用且已有后继版本的 JSON 已移至 `/Users/hxx/Documents/无限画布_清理隔离/2026-07-31-git-audit/obsolete-evidence/`，未直接删除 |
| 并行边界 | 小说记忆库 P0 正由另一活动计划 `.planning/2026-07-31-novel-memory-library-v1` 持续写入；其文件未暂存、未提交、未清理 |
| Git 边界 | 仅本地 commit；未 push、未建 PR、未发布、未部署，也未改写正式项目素材 |

## 2026-07-29 09:25 · 《嘟嘟》108/108 BindingSet current

| 字段 | 当前事实 |
|---|---|
| 结论 | **已完成（BindingSet 范围）**：108/108 current，stale=0，noBindingSet=0，未决提案=0 |
| 起始基线 | 实时控制面为 current=0 / stale=8 / noBindingSet=100；历史“8 份已有 BindingSet”均已 stale |
| 当前规模 | 22 units / 108 panels / 129 份 BindingSet 历史记录；当前 108 个 head 全部 current |
| 实体决策 | 1646/1646 proposal 已明确 accept 或 exclude；逐格正向资产 397 项，涉及 13 个唯一资产 |
| Authority | 全库 16 canonical / 15 有 Primary；当前实际绑定的 13 项全部 approved，Primary SHA 与版本 SHA 闭合 |
| 命令范围 | 43 份报告、1872 条命令；仅 analyze / resolve / freeze BindingSet；4 次中间 fail-closed 已受控恢复 |
| 零生图副作用 | 首批前到最终：generation ledger、generation tree、downloads、requests、正式 RAW tree 五项全部不变 |
| 当前构建 | sourceDigest `b4439e7bd9032caf8a0c511c6016dc46e868d0ebd2e3561db8486b0a32801d22` / 202 tools / build+runtime current |
| 证据 | `.planning/2026-07-28-dudu-six-realm-battle-completion/binding-set-108-final-validation.json`，12 gates 全 true |
| 非结论 | BindingSet `generation-ready` ≠ 正式 reference envelope / RAW / Review ready；9 格正向资产超过参考上限 6 |
| 继续阻断 | K20-S01～S03 仍 generation_unknown / PLAN_ONLY / BLOCKED；前镜、精确视图、E-R1 版本仍须逐镜闭合 |
| 边界 | 未生图、未派发 generation pack、未提交 raw/labeled 或 Review；未 Git stage / commit / push / PR |

## 2026-07-28 22:56 · 最终签名 App 与规模验收

| 字段 | 当前事实 |
|---|---|
| 结论 | **部分完成**：软件修复、自动化、签名封包、安装版启动和 10k 规模 PASS；真人鼠标 Finder / 其他 App 物理落点仍未 PASS |
| 最终安装版 | `/Applications/AI 漫剧画布.app`，version 0.2.0，arm64 |
| 构建身份 | buildId `38dbb556ec8ff28a7e669ba2e72b8e8b` / sourceDigest `b4439e7b…` / 202 tools |
| 签名 | Developer ID `YIHANG LI (3JS43BTTJ3)`，codesign deep / strict PASS |
| 归档 | `/Users/hxx/Documents/无限画布_交付归档/app-build-20260728-38dbb556ec8ff28a7e669ba2e72b8e8b` |
| DMG | SHA-256 `b26e19dd8c3b…b7651`；`hdiutil verify` PASS；local-only，未公证 / 发布 |
| 安装验证 | App 自带 Electron runtime 启动；系统 Node 非必需；MCP 实际 202 tools |
| 规模验证 | 77 assets / 1288 units / 4235 panels / 10000 media；10 次切工程无串库；RSS +56848 KiB；FD +1 |
| 最终 fast | 188 files / 941 tests PASS |
| 本轮修复 | viewport 保存串行化、总资源统一快照、拖出资源上界、切工程 busy 竞态、规模 / 安装验收工具 |
| 物理门 | `sky.drag` 无按住 / 分段 / 松键时序；Finder 只获焦、0 文件，结构化状态 `blocked`，不得报 PASS |
| 报告 | `docs/验证报告_20260728_总资源缓存媒体拖出与安装版最终验收.md` |
| 边界 | 正式项目零写；未公证、发布、上传、付费；未 Git stage / commit / push / PR |

## 2026-07-28 16:34 · 并行软件增量：总资源快照与媒体拖出

| 字段 | 当前事实 |
|---|---|
| 只读门禁 | 7 个总资源 IPC 通道已登记为只读 / 缓存读取；未知通道保持 mutation / strong |
| 跨项目缓存 | 进程内目录快照；29 注册工程 / 27 可读 DB；图片冷建只扫描 27 DB 一次，分类、搜索、翻页热读不重扫 |
| 后台增强 | 固定并发 4；切工程 / 刷新后停止剩余 IPC，迟到结果不提交 |
| 媒体拖出 | 图片 / 视频 / 音频独立复制体；一次性 sender-bound token；Main `startDrag`；CAS / 画布原件保留 |
| 定向回归 | 11 files / 77 tests PASS；`git diff --check` PASS |
| 构建 | buildId `c307eaba01557cafa72e2684bbe383ef` / sourceDigest `5ddecb04…` / 202 tools |
| Electron | 隔离 v2 PASS，三媒体 native bridge、复制体和安全边界通过 |
| 未完成 | Finder / 其他 App 物理落点因用户新消息中止；`viewport` 保存竞态已定位但未修复 |
| 边界 | 正式项目零写；未安装 / 发布；未 Git stage / commit / push / PR |

## 2026-07-28 07:42 · 活动 Goal：真实生图驱动无限画布改进

> **当前唯一活动目标**：`.planning/2026-07-28-dudu-six-realm-battle-completion/task_plan.md`。北星已按用户要求重排为“所有正式生图继续使用无限画布；真实生产暴露缺口后修成通用产品能力、验证同一候选恢复，再回到下一镜”，禁止为了赶图绕开画布。

| 字段 | 当前事实 |
|---|---|
| 活动工程 | `projects/local-import-dudu-six-realm-battle-403d9043` / `project-0e5a8942e3bf` |
| 当前镜头 | K12-S05 attempt 1 已唯一调用一次 Codex imagegen；正式 raw/labeled 原子 commit，待 Review REJECT |
| 视觉裁决 | 主体/灯/丝/场景成立；E-R1 被放大成大块斧刃状残片，违反米粒级且小于灯笼的硬锁 |
| 本轮产品修复 | panel 宽银幕、protocol v2 call、labeled 长字幕、确定性 unknown 对账、panel build rebind/同候选恢复 |
| 当前候选 | `mcp-candidate-fa860c6dedf88a46-65803ddf54c53d45-9a3a2967`；sourceDigest `fa860c6d…`；buildId `50f3e173…`；202 tools |
| 同候选恢复证据 | K12-S05 候选 SHA `ffbc5c8d…980e3`；rebind 后 raw/labeled SHA `ffbc5c8d…980e3` / `61ab0670…091b` |
| 当前下一动作 | Review REJECT → 对账清零 → attempt 2 correction/retry → 同画布全链复验 → K12-S06 |
| 边界 | 未二次生图、未复制到正式源 RAW、未 Git stage/commit/push、未安装/发布 |

> 当前恢复结论：截至 2026-07-28 03:38 CST，历史 P0—P9、最终源码候选、5/5 历史 live 探针和 3 单元 / 10 宫格视觉样本均保持 PASS；ChatGPT/Codex 已完成客户端重启，当前 app-server 实际拉起最终 `e9756c… / 4575ff48… / 202 tools` 候选，五键身份门与活动工程全部匹配。`MCP_CLIENT_RESTART_PASS`，无需再次重启。
>
> **边界**：当前不可变 MCP 候选仅为 local-only 源码运行候选；未替换历史归档 App，未安装、签名、公证或发布。本轮三单元样本未使用 Grok、未上传、付费或生成视频。Git 未 stage/commit/push/PR；当前源码/测试/报告修改有意保持未提交，正式工程/CAS/raw/labeled 未删除、未迁移。

## 2026-07-28 03:38 · MCP 客户端重启 PASS

| 字段 | 当前事实 |
|---|---|
| 磁盘配置 | 指向最终 `mcp-candidate-e9756c…`，recorded sourceDigest/入口 SHA 正确 |
| 当前源码 | `e9756c099e6b1ec7…`，与最终候选一致 |
| 当前 app-server | PID 27305，03:33 启动 |
| 当前运行 MCP | PID 27940，argv 指向最终 `mcp-candidate-e9756c…` |
| 单写锁 | PID 27940 持有，锁内 argv0 与最终候选入口一致 |
| get_capabilities | buildId=`4575ff48…`、sourceDigest=`e9756c…`、server.toolCount=`202`、runtime restartRequired=false |
| 活动工程 | `/Users/hxx/Documents/无限画布/projects/local-import-dudu-world-prologue-b8bfcf14` |
| 只读探针 | 候选完整性、capabilities、活动工程、物理零写 4/4 PASS；drift 探针按只读边界未重跑 |
| 裁决 | `MCP_CLIENT_RESTART_PASS`；无需再次重启，可在后续明确任务中按门禁恢复正常操作 |

## 历史待办 · 2026-07-28 03:20（已由上方重启 PASS 接替）

| 字段 | 当前事实 |
|---|---|
| 磁盘配置 | 指向最终 `mcp-candidate-e9756c…`，recorded sourceDigest/入口 SHA 正确 |
| 当前源码 | `e9756c099e6b1ec7…`，与最终候选一致 |
| 当前运行 MCP | PID 84576，实际为旧 `mcp-candidate-db96767…` |
| 父进程 | PID 94983，ChatGPT/Codex `app-server`，启动于配置切换前 |
| 单写锁 | 当前仍由 PID 84576 持有 |
| 裁决 | 必须完整退出并重开 ChatGPT/Codex；无需重启 Mac 或 AI 漫剧画布.app |
| 重启后完成门 | argv=e9756c 候选、buildId=4575ff48、sourceDigest=e9756c、202 tools、活动工程=local-import-dudu-world-prologue-b8bfcf14 |
| 重启前边界 | 禁止 mutation、生图、重放 U03 unknown、清理工作树 |

## 2026-07-28 00:09 · 最终 MCP 候选与三单元真实连续样本

| 字段 | 当前事实 |
|---|---|
| MCP 候选 | `.aicanvas-runtime/mcp-candidates/mcp-candidate-e9756c099e6b1ec7-1597537cee368347-9888aa8b` |
| 构建身份 | version 0.2.0 / sourceDigest `e9756c099e6b1ec7…` / buildId `4575ff48b3b96e236b68a46bc00149dd` / 202 tools |
| 切换与重连 | Codex 配置已指新候选；旧 PID 20996 精确核验后停止；新候选 singleton 握手与锁身份 PASS |
| live 探针 | 5/5 PASS：候选完整性、capabilities、活动工程、物理零写、drift fail-closed |
| 真实样本 | `output/final-real-continuity-20260727/run-01`；3 单元 / 10 宫格；成年阿航 + 神权密室 + 唯一完整 D01 |
| U01 | attempt 1 REWORK 保留；attempt 2 PASS/current/approvedRawEligible |
| U02 / U03 | attempt 1 PASS/current/approvedRawEligible |
| 生图终态 | 三条接受调用均为 provider=codex 且有 `result-committed`；无待重试生图 unknown |
| 视觉验收 | 三张 941×1672 raw、三张 labeled 与 10 宫格联系表原尺寸复核 PASS |
| 可选例外 | U03 video-package prepare command=`unknown`；进程已死、export intent=0、not-prepared、无副作用，未重放 |
| 活动/租约 | 活动工程已恢复《嘟嘟》；样本 lease 已释放 |
| 验证 | 三套 typecheck、生产回归、continuation、immutable/currentness/runtime gate 均 PASS；独立审计 GO |

## 2026-07-27 14:47 · Git 安全收尾

| 字段 | 当前事实 |
|---|---|
| HEAD | `main`，4 个逻辑提交：维护边界 → 当前源码 → 测试/构建身份 → 文档/证据 |
| 纳管范围 | 配置、当前源码、测试、脚本、文档与精简证据；正式工程、生产输出、runtime、供应商镜像和大媒体保持不纳管 |
| 新鲜导出 | 从 HEAD `git archive` 导出 1,738 文件；`npm ci`、三路 TypeScript、`npm run build` 全部 PASS |
| 身份复算 | 848 source files / 17,015,890 bytes；sourceDigest `d4b07c20…`、buildId `40b9cc72…`、MCP 202 |
| 关键测试 | build identity / watch paths / release manifest / packaged MCP：4 files / 40 tests PASS；测试分区审计 302/302 |
| MCP smoke | 编译 MCP 真实握手：202 tools / 202 unique、2 resources、9 templates、8 prompts |
| 候选等价 | fresh `out/` 81 文件与归档候选逐内容一致；`dist-mcp/` 零差异；身份合同字段一致 |
| Git 状态 | 主索引已原子同步；`git status --porcelain=v2 --untracked-files=all` 为 0；无 remote、未 push |
| 恢复物料 | 旧索引/元数据：`/Users/hxx/Documents/无限画布_交付归档/git-recovery-prebaseline-20260727-2f4948e8`；正式数据副本：`/Users/hxx/Documents/无限画布_生产数据备份/20260727-pre-git-baseline` |
| 对象库边界 | 散对象本体约 23.83 GiB，含旧索引依赖对象；另有 3 个临时垃圾文件约 2.43 GiB。文档提交曾自动触发后台 maintenance/gc/repack，发现后已终止且未形成 pack。已设本地 `gc.auto=0`、`maintenance.auto=false`；任何清理仍须另行确认 |

## 2026-07-27 13:20 · Grok current-source live 追加验收

| 字段 | 当前事实 |
|---|---|
| Grok → MCP | Grok Build 0.2.112 只读调用当前源码 MCP；202 tools、buildId `40b9cc72…`、sourceDigest `d4b07c20…`、buildCurrentness=true |
| Grok 生图 | 后端 `grok-build-imagine`；`image_gen` 明确调用 1 次、并发 1、未重试 |
| 落盘 | raw JPEG 720×1280，SHA `5cd5b448…c84ae`；labeled PNG 720×1280，SHA `694b7d74…8299` |
| Review | 独立原尺寸 Review=`pass`；raw/labeled 原子登记；`approvedRawEligible=true` |
| Dashboard | 首次重读触发 fail-safe `generation-projection-degraded`；未重复生图。复用同一 raw/labeled 在新隔离工程机械回放，3/3 为 `ready / approved-raw-ready` |
| 定向回归 | `tests/real-imagegen-canary-v2.test.ts` + `tests/studio-production-dashboard.test.ts`：2 files / 11 tests PASS |
| 供应方边界 | 有 Grok CLI 会话与 Agent 自证；`cryptographicProviderReceipt=false`，不冒充 xAI 密码学回执 |
| 生产边界 | 正式 Dudu 未写；`productionContinuityPassed=false`；该 canary 验收过程没有安装、发布或 Git；后续 Git 基线见上节 |
| 证据 | `docs/evidence/real-imagegen-canary-20260727-grok-current-source.json` 与同名前缀文件 |

## 2026-07-27 12:50 · P0—P9 最终关账快照

| 字段 | 当前事实 |
|---|---|
| 真实工程 | `projects/local-import-dudu-world-prologue-b8bfcf14` |
| 工程概览 | 19 assets / 3 units / 10 panels / 266 media / 108 documents |
| 正式生成 | W00_G01 两次 Codex run；attempt 1=`rework`，attempt 2=`pass`；4 results raw/labeled 全配对 |
| 四轨 | script/image/video/audio 全部可用；12 秒 H.264 + PCM 经 `aicanvas-studio:` 实际播放 |
| 测试 | 302 files / 1699 tests PASS；fast 172/853、medium 90/712、integration 35/119、heavy 5/15 |
| 构建 | `0.2.0` arm64；sourceDigest `d4b07c20…`；buildId `40b9cc72…`；MCP 202 |
| 性能 | 稳定 5 样本 p95：CDP 592.6ms、首卡 854.6ms、首 raw 1314.8ms、全参考 1340.6ms、IPC=4；最终包另有直接严格 PASS |
| 稳定性 | 30 分钟 soak PASS；30 cycles / 60 switches；RSS 尾段 -26.976%；FD delta 0；SIGKILL 后恢复 |
| 恢复 | before-call / generation_unknown / result CAS / Review / Observation / Video receipt 六阶段均 PASS |
| 跨项目 | 非 Dudu 真实受管工程完整隔离 canary PASS；源工程零写；providerInvocationCount=0 |
| 完整性 | 6 库 quick_check=ok；266 媒体存在/大小/SHA/解码全 PASS |
| 证据入口 | `docs/验证报告_20260727_P0至P9生产中枢最终验收.md` |

## 历史快照 · 2026-07-26 22:35（已被上方最终关账接替）

> 当时结论：**P0+P1 关账**：MCP=候选 v4（e3a5b3d4…）；7 项资产 Review+Primary（authority events 7）；十格 BindingSet head 全部 generation-ready（bindings 18/decisions 24）；P1 全程走候选 MCP execute_command＝Codex 可控首次真实全链演练。该段仅保留为历史，P2—P9 “未开始”已经作废。P1 期间修复真实断链：声明引用指向源层外锁库时 SHA 回填永远 null（content-import 新增 external origin 双复验 fallback；94 测试回归 PASS）。证据：docs/evidence/p1-asset-authority-20260726/。

## 2026-07-26 21:45 · P0 关账快照

| 字段 | 当前事实 |
|---|---|
| 范围 | 只维护源码；未安装、未发布、未生图、未改正式素材、未执行 Git |
| 真实工程 | `projects/local-import-dudu-world-prologue-b8bfcf14` |
| 受管生产 | 3 units / 10 panels / 10 image timeline bindings |
| 资产 | 259 media；18 assets / 18 pending versions（另烛龙媒体已入库未建资产，P1 补建） |
| 权威/引用/生成 | Review=0、Primary=0、BindingSet=0、continuity=0、generation 全 0（P1—P4 目标） |
| 四轨 | script 与 source storyboard 可读；video=0、audio=0 |
| **当前 MCP** | **已切换**：config 指向不可变候选 `mcp-candidate-673a2ebe…-68e93510`（sourceDigest=673a2ebe…、入口 SHA=d6e8a3bd…、201 工具、只读封印）；含 RECORDED_SOURCE_DIGEST 与新增 RECORDED_RUNTIME_ARTIFACT_SHA256；旧 PID 46218 已停、锁已清理 |
| live 探针 | 5/5 全绿：候选完整性 / capabilities 716ms（allowed=true、digest 一致）/ active context 6ms / 物理零写（净新增=[]）/ drift fail-closed（真实 BUILD_CURRENTNESS_MISMATCH 拒绝，探针文件已清理摘要复原） |
| P0c 修复 | mutation epoch 有界重验 fail-closed（+2 指标）；stdio 幂等 shutdown 链（EOF/close/三信号/onclose 共链，启动期信号窗口已封，guard registerSignalHandlers:false）；isError 计失败 + gate 计时 try/finally（IPC 同构） |
| 审查闭环 | 双路审查：1 MEDIUM（启动期信号窗口）已修验证；SIGINT 测试已补；2 项记后续切片（registerResource/Prompt 入 gate、IPC 哨兵计 failed） |
| 完整 fast | 冻结轮完整跑完 4143s：255/256；唯一失败=mcp.test.ts 30s testTimeout 撞顶（实证非回归：120s 下 PASS、epoch retries=0、冷启 752ms），已加 120s 超时复验 PASS；探路轮曾修 2 存量失败（node:sqlite enableDefensive、trace-ui 断言） |
| 测试基线 | 294 文件机械闭合（脚本实测）：fast 256 / integration 34 / heavy 4；union=all、overlap=0、missing=0 |
| 隔离 build/UI | verify:t23 passed（live dist-mcp 未动）；UI 复验 ok=true 0 FAIL（layer4-20260726-p0d-final），构建身份=当时源码摘要 |
| 性能新实测 | MCP 冷启至 initialized 1.2s；mutation 门禁全仓摘要 180-270ms/次；epoch 重验 0；首单元 7.6-17.6s（dev+并行负载，P7 治理） |
| 五要素评分 | 三代理平均（当前）：内容 3.3 / 闭环 1.7 / Codex 3 / UI 3.7 / 性能 3 ≈ 总体 3/10；P1—P4 后预测 ≈5.5/10 |
| 唯一计划 | `.planning/2026-07-26-production-hub-closure/next_phase_plan.md`（**含 v2 修订摘要 12 项**） |
| 下一步 | P1（烛龙补建→6 资产 Review/Primary→十格 analyze→resolve→freeze；清单在会话 scratchpad）；P0.5 测试分层健康化与 P0.6 guard 锁原子化可并行 |

## 历史目标 · 残留任务清账（2026-07-25 已关账）

| 字段 | 值 |
|------|-----|
| 更新 | 2026-07-25 17:55 |
| goal | `docs/GOAL_残留任务清账_20260725.md` |
| 状态 | **GOAL_CLOSED** |
| gaiden S1E2 | **pass=25** · blocked=1（wizard demo） |
| U25 | **pass** raw `353850d35ef3…` |
| 代码 | review-control stale 解锁 rework；target-state 账本优先 |
| 证据 | `docs/evidence/residual-backlog-20260725/FINAL_REPORT.md` |
| 红线 | 未写 dudu-s1e1 / codex PASS |
| block_kind | none |

### 历史下一步
**无强制待办。** 可选：新集产线 / SSL-6 / NLE·视频·Grok live 另开 Goal。

## 2026-07-26 · 先前源码验收证据

先前 T23、v5 规模 smoke、视频包竞态和导入收据仍是有效的历史切片证据，但其中的项目计数已经被上方 17:02 当前快照接替，不得再用于恢复当前数量。

- `docs/evidence/source-project-ui/layer4-20260726-production-hub-closure-retry3/`
- `docs/evidence/source-project-ui/scale-20260726-production-hub-closure/t23-source-dev-scale-20260726-codex-v5.json`
