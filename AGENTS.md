# AI 漫剧无限画布 · 项目规则

## 语言

默认简体中文。代码标识符、路径、命令可保留英文。

## Goal / 长任务自动续跑（2026-07-23 硬规则）

权威：`docs/GOAL_自动续跑与恢复协议.md`。进度真相源：`STATUS.md` / `TASKS.md`。  
**北星合同：`docs/GOAL_双轨_生图与画布互补契合.md`。**  
**热路径宪法：`scripts/goal-resume-prompt.txt`（v2：完成门五键 + 假关账拦截；见 `docs/GOAL_提示词全面优化_20260723.md`）。**  
**壳层/工程化裁决（Goal 内）：`docs/GOAL_Qwen建议多代理裁决与长期任务_20260724.md`** — 改写采纳 Phase D/E；禁整包照搬；工程化不打断 A formal。
1. **禁止**切片完成就 `update_goal(completed=true)`；仅整目标关账后可 completed。  
2. **回合末禁止**只输出「下一步」清单；必须工具续做，或 STATUS 已写真阻塞（仅用户能解）。  
3. 基础设施（已落盘）：  
   - Stop 闸 `~/.grok/bin/goal-stop-continue.sh` + `~/.grok/hooks/goal-continue-stop.json`  
   - 持久 scheduler（2m / durable / foreground）读 STATUS 续跑  
4. compact / 新会话：先读 STATUS earliest，立刻干，不从零问目标。  
5. Skeptic/修 bug 结束后立刻回产线 earliest，禁止停在解释。  
6. **双轨（owner 终局）**：一边 Grok/Codex 按剧本生图，一边完善无限画布对生图的关键辅助——**角色 / 场景 / 站位（及同级）一致性**，目标互补到高契合；有序 formal PASS **≠** 产品 100% 完美契合。产线卡点暴露的辅助缺口必须同会话收敛后再回 earliest。  
7. **剧本产品环（owner 2026-07-23）**：存放剧本、阅读、一键剧本↔图对照、15 秒分镜设计 — 计划 `docs/GOAL_剧本库与15秒分镜产品计划_20260723.md`；复用 script revision / `suggest_studio_storyboard_draft` / trace，禁止平行剧本库。## 严谨执行（2026-07-18 起）

- 全局方法：`~/.grok/memory/rigorous-execution-mode.md` 与 `~/.grok/memory/MEMORY.md`。
- **窗口交接唯一入口：`docs/当前开发交接.md`**。
- **软件关账事实源**：`docs/验证报告_20260718_P0至P10最终关账.md`、  
  `docs/验证报告_20260718_P9R2_P10R2与受管无限画布最终收尾.md`、
  `docs/验证报告_20260719_P11_P14零说明桌面生产闭环.md` 与对应 final-validation JSON（**PASS，禁止覆盖/删除**）。
- **残差深度层**：P9-R2 / P10-R2 已 PASS；真实 Codex canary 见  
  `docs/evidence/real-imagegen-canary-20260718-codex-v2-final.json`。真实 Grok 外部调用未在本 Codex 会话执行，不得伪造。
- 事实 > 报告；当前运行 > 过期交接；机械通过 ≠ 正式成片 / 自由无限白板产品 UI。
- 完成只用：已完成 / 部分完成 / 阻塞 / 失败 / 未开始。
- 新会话：先读交接 → 自检命令 → 再改代码。

## 研发状态（2026-07-19 当前基线）

| 层 | 状态 | 说明 |
|----|------|------|
| P0–P7 owner | **PASS / 保持** | 禁止无授权重做/重迁移/替换 |
| **P8 生产驾驶舱** | **PASS（final-validation）** | **禁止因过期交接重建 P8**；≠ 自由无限白板 |
| **P9 可靠性合同** | **PASS（final-validation）** | 全写入口故障矩阵等为残差增量 |
| **P10 构建身份合同** | **PASS（final-validation）** | 运维级备份/旧构建矩阵等为残差增量 |
| P9-R2 / P10-R2 | **PASS（final-validation）** | SQL keyset、10k CAS、Electron 规模 UI、稳定构建身份、备份与 canary 已关账 |
| 受管无限画布 | **PASS（Electron smoke）** | 资产/单元/宫格/连续性，分页、视口剔除和切工程隔离；不一次性挂载全量 DOM |
| **P11–P14 零说明桌面闭环** | **PASS（Codex-primary final-validation）** | Codex live、真实 canary、备份恢复、规模与 30 分钟 soak 已关账；Grok live 按用户要求 NOT_RUN |
| 正式工程 | `projects/codex-ai-drama-studio` **活跃受管工程** | 约 1.1GB；85 资产、541 单元、3246 宫格、1152 媒体；不得按旧“空库”结论处理 |
| 本机桌面端 | **0.2.0 已安装** | `/Applications/AI 漫剧画布.app`；Developer ID 本机签名；local-only，未公证、未公开发布 |
| 正式生图供应 | **Codex 主供应**（`agent-imagegen`） | Grok 仅保留离线兼容；禁 Artlist/浏览器；应用不内嵌模型 |

权威交接：`docs/当前开发交接.md`  
旧「P7完成_P8起点」交接、过期 README 段落 → **历史**；不得覆盖 final-validation。

## 后续允许的工作类型

- 使用已关账桌面端与 MCP 开始新的 Codex 生产纵向切片
- 在 **既有 owner** 上修复由真实生产暴露且可复现的缺陷（无平行 DB/真相源）
- 文档、交接、验证证据与 Skill 边界校正

**禁止**：重建 P0–P10 owner；Git stage/commit/push；付费/上传/公证/公开发布；把正式受管工程当空库重建或重新导入。

## 社区技能与规范（已落盘）

- `docs/community-research/INDEX.md`
- `docs/community-research/全网社区技能与规范分析_20260718.md`
- `.grok/skills/ai-drama-canvas-agent` — 软件研发边界（**P8 已关账**）
- `.grok/skills/ai-drama-production-prompts` — 短剧提示词/连续性/宫格
- `.grok/skills/canvas-scale-performance` — 画布规模性能

社区 vendors 与本机 skill 镜像仅供参考；**不得**把 Playwright/网页生图 skill 接入正式供应链。

## 正式生图执行面（Codex 主供应，Grok 离线兼容）

- 冻结包 `executorKind = agent-imagegen`，`allowedProviders = ["codex","grok"]`。
- 应用内**不**内嵌生图模型；Agent 消费冻结包后回写。
- `dispatch_studio_generation_pack` **必须**声明 `provider: "codex" | "grok"`。
- 新结果通过 `commit_agent_imagegen_result_bundle` 原子导入 raw、派生 labeled 并登记；provider 必须与 dispatch 一致。
- 禁止：浏览器/Artlist/网页自动化作为正式生图供应商。

当前执行默认固定为 `provider=codex`。用户已因无额度移出 Grok live；不得调用 Grok、消耗额度或把本地配置兼容写成实时通过。

标准零说明调用顺序固定为：

`get_capabilities → get_active_managed_studio_context → readiness / freeze / dispatch → commit_agent_imagegen_result_bundle → Review`

- P19 起：审片前可调用只读 `get_studio_consistency_evaluation` 获取机器一致性辅助判定（一致/需复核/明显漂移/无法检查四态；机器不自动 Review PASS）。
- P20 起：剧本拆格可用只读 `suggest_studio_storyboard_draft`（严格 15 秒 2–6 格；扩写 extension 格不锚原文、仅末尾连续后缀，扩写不冒充原镜）。
- P21 起：`create_studio_generation_plan` 建立逐宫格计划（内容寻址幂等，重复开始不重复派发；plan 创建不派发）；命中 plan 节点的 pack 派发必须使用计划推导 runId（`<planId>:node:<i>:attempt:<n>`）；`fail_studio_generation_run` 登记失败（不登记则该宫格永久 in-flight 并触发 `panel-run-in-flight`）；`cancel_studio_generation_run` 取消（仅停账本跟踪，已出图结果不删）；`retry_studio_generation_plan_nodes` 幂等重试失败/取消节点（attempt/lineage 保留，旧结果不动）；已取消 run 拒绝新结果登记（`run-cancelled`）；同宫格存在非终态 run 时拒绝重复派发（`panel-run-in-flight`，detail 含 blocking runId）。逐节点状态经 `get_studio_generation_control` 的 `plan` operation 读取。
- P24 起：生成全链双向追溯走只读 MCP `get_studio_trace`（by-pack/by-run/by-result 当时链投影、script-revision-impact 反向反查；历史身份经冻结包还原不读 head；预期/非预期变化分类 fail-safe，非预期必须人工复核）；`get_studio_production_unit_snapshot` 可选 `unitRevision` 读历史快照。桌面端冻结包身份/结果行分类/Review 身份/文稿修订历史均为只读诊断面。固定样本 baseline（tests/fixtures/p24-trace-golden.json）只能经 `P24_GOLDEN_UPDATE=1 npx tsx scripts/update-p24-golden.ts` 显式审核更新，禁止手改或静默覆盖。

- 当前 MCP 工具数由 `release-manifest.json` 动态读取；已安装 0.2.0（P15）为 183，源码构建自 P19 起为 186，禁止把 165/180/181 等历史快照写成当前常量。
- 桌面端“Agent 连接”使用 App 自带 Electron runtime 启动 MCP，不依赖系统 Node；切换工程只更新共享活动注册表。

## 黄金面具唯一权威硬锁

- 唯一权威图：`/Users/hxx/Desktop/豆姐参考图.png`
- SHA-256：`02e9438ecee038f7d14860da37cb315bf358db4a26fa224e342eee5b592b55a9`
- 正式资产：`prop-d01-golden-mask`，revision 9，Review `approved`。
- 任何提示词、冻结包和参考板必须使用该权威版本；旧 D01 Binding、连续性、冻结包和生成结果均为 `stale` 历史，不得提升为当前权威。
- 禁止半面具、裂面具、口型、换结构或以文字描述覆盖权威图；用户权威图只读，禁止回写。

## 架构红线

- 文件系统 / 工程 CAS / SQLite 索引是事实源；UI 不推导 nextAction。
- 写入走 `execute_command` + revision CAS；读可走专用 MCP。
- 已知资产禁止静默 text-only；歧义禁止静默选第一个候选。
- 媒体本体不进 JSON/画布节点；列表分页 + 视口懒加载。
- 15 秒单元 2–6 宫格；raw 单图生成，中文宫格板本地排版。

## 验证

改动后按对应 `scripts/validate-*.ts` 与 smoke 实跑；无证据不宣称完成。

## 禁止

- 回写 `/Users/hxx/Documents/古蜀卷第三季`、封神篇剧本目录、用户权威参考图
- 覆盖 `docs/evidence/**` 与已有 final-validation
- 在无 Git HEAD 工作区上 destructive git（reset/clean）
