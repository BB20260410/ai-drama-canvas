# L33 后残差分析 · BUG / 优化 / 完善

> 时间：2026-07-23  
> 前置：L33 半成品接线 + typecheck + identity 重冻 + Codex live NOT_RUN  
> 方法：磁盘证据 + 源码接线审计 + 关账清单对照（非全仓零缺陷扫荡）

## 0. 本轮已消除的落差

| 项 | 状态 |
|----|------|
| unit-grid nextAction 仅单测未接产品 | **已接** Dashboard unit 操作 |
| quarantine 门仅脚本用 | **已接** commit `inspectRaw` |
| 时间线 filter 仅 Core | **已接** ManagedStudioCanvas 进度搜索 UI |
| unit-grid brief 缺 controlRefs/九字段 | **已接** `buildStudioUnitGridAgentImagegenBrief` |
| Codex 脚本硬编码路径 | **已参数化** `--precall/--workdir/--workspace` |
| typecheck | **PASS** |
| build identity | **aligned** `5f79a866…` / `63448ccb…` |

## 1. 仍有的 BUG / 缺陷（按严重度）

### P0 — 生产正确性

| ID | 问题 | 说明 |
|----|------|------|
| R-P0-1 | **Codex live 全链未证明** | 门禁绿，但未真实 dispatch→生图→commit→Review |
| R-P0-2 | **《嘟嘟》U28/U29 generation_unknown** | 只允许对账，内容续作仍 BLOCKED |
| R-P0-3 | **MCP 写路径依赖源码 dist-mcp** | 改代码后未 rebuild 会 BUILD_CURRENTNESS_MISMATCH（本轮已遇） |

### P1 — 一致性合同（P30-C 未关，仍有效）

| ID | 问题 |
|----|------|
| R-P1-1 | 跨单元 approved raw 接力 |
| R-P1-2 | 九字段 **端到端** 注入后的视觉/机械 QC 矩阵未 live 验证 |
| R-P1-3 | forbidden 正向泄漏 fail-closed |
| R-P1-4 | Review 原尺寸必审 target-aware 矩阵 |
| R-P1-5 | Grok agent-tool attestation 与 fixture 边界硬化 |
| R-P1-6 | 迟到 same-call 恢复产品化 |

### P2 — 体验 / 工程

| ID | 问题 |
|----|------|
| R-P2-1 | Dashboard unit-grid nextAction 依赖 history 粗投影，无 Review head 精确 join 时可能偏粗 |
| R-P2-2 | 时间线进度搜索启发式（unitId vs 角色）较简，复杂查询易不准 |
| R-P2-3 | 超大文件：ledger ~6k、mcp server ~5k、canvas vue ~3k |
| R-P2-4 | 慢测（video-package ~150s）拖垮反馈环 |
| R-P2-5 | Git 无 HEAD + 超大 dirty tree — 协作与备份风险 |
| R-P2-6 | 安装版 0.2.0 vs 源码 189 混用仍会「像 bug」 |
| R-P2-7 | Electron smoke / 多单元 live canary 仍 NOT_RUN |

## 2. 可优化

1. **测试分层**：gate（<30s）/ full；慢测标 `slow`  
2. **模块拆分**：ledger / video-package / ManagedStudioCanvasView 按读投影·写事务·UI 切片拆  
3. **Dashboard 精确态**：unit-grid call/result/review 一次投影 API，避免 history 推断  
4. **进度搜索**：显式 unit/角色/状态三控件，少用单框启发式  
5. **开发者体验**：改 core 后自动提示 `build:mcp` + identity  

## 3. 可完善（对齐产品真北，排序）

| 优先级 | 项 | 价值 |
|--------|----|------|
| 1 | 隔离工程 **1 次 Codex 新 run live 全链** | 双供应从合同变事实 |
| 2 | brief 九字段 **live QC 矩阵** + forbidden fail-closed | 一致性短剧质量 |
| 3 | ≥3 单元 live + rework 环 | 真生产节奏 |
| 4 | Seedance 真实逐格裁图 SHA 进视频包 builder | 真视频前夜 |
| 5 | 《嘟嘟》unknown 可信关闭后再 M2/M3 | 正式内容 |
| 6 | 驾驶舱可见性抽检 + Electron smoke | 产品手感 |

## 4. 明确不是 BUG

- 非自由无限白板  
- 未公证/未公开发布  
- 未 live Seedance 出片（合同范围）  
- P0–P14 已关账 owner 禁止重建  

## 5. 一句话

**L33 已把「半成品接线」做成产品路径；剩余主矛盾是 live 双供应验证、一致性 P1 子集、以及内容工程 unknown 墙——不是 typecheck 崩溃。**
