# STATUS · 当前源码生产中枢（P0—P9 CLOSED）

> 当前恢复结论：截至 2026-07-27 14:55 CST，**P0—P9 已在源码 + 隔离本机候选包范围关账，Git 安全基线也已建立并验收**。最终源码身份 `sourceDigest=d4b07c20…`、`buildId=40b9cc72…`、MCP 202 tools；正式 Dudu 工程真实 Codex 受管生图完成 attempt 1 rework → attempt 2 pass，四轨媒体、剧本产品环、跨项目资产复用、性能硬门、30 分钟 soak、六阶段 SIGKILL 恢复、非 Dudu 真实工程隔离 canary 和 302 files / 1699 tests 均闭合。用户随后授权的 **Grok current-source live 隔离 canary 也已 PASS**；最终报告与追加证据见 `docs/验证报告_20260727_P0至P9生产中枢最终验收.md`。
>
> **边界**：候选包已持久化为 `/Users/hxx/Documents/无限画布_交付归档/0.2.0-40b9cc725097394108667c877901446a/AI 漫剧画布.app`，local-only，未安装、未签名、未公证、未发布；未上传。Grok 只在全新隔离合成工程调用一次 `image_gen`，没有写正式 Dudu；其 Review scope 为 `synthetic-canary-contract`，不冒充正式生产连续性或用户本人批准。Git 仅建立本机 `main` 基线，没有 remote、push、PR、gc 或 prune；正式工程/CAS/raw/labeled 仍在忽略边界外，未删除、未迁移。

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
