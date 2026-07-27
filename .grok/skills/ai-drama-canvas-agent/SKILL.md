---
name: ai-drama-canvas-agent
description: 在「AI 漫剧无限画布」仓库内做软件研发时强制使用。覆盖 P0–P10 已关账边界、P11–P14 桌面生产闭环、owner 复用、驾驶舱只读合同、MCP/CAS/门禁。触发：无限画布、StudioProductionDashboard、BindingSet、连续性、宫格、managed studio、P11–P14。
---

# AI 漫剧无限画布 · 研发 Agent 规范

## 先读（按序）

1. `docs/当前开发交接.md`（**唯一实时交接**）
2. `STATUS.md` / `TASKS.md`（Goal 进度）
3. `docs/GOAL_双轨_生图与画布互补契合.md`（**/goal 北星**：生图 + 画布一致性辅助互补）
4. `AGENTS.md`
5. `docs/验证报告_20260718_P0至P10最终关账.md` + `docs/evidence/final-validation-20260718-p8|p9|p10-*.json`
6. 残差层：`docs/验证报告_20260718_P9R_P10R重验收关账.md` / `*p9r*` / `*p10r*`
7. `docs/community-research/INDEX.md`
8. `docs/开源项目借鉴审计_2026-07-13.md` 与（若存在）最新 `docs/参考项目增量差距审计_*.md`

历史交接 `docs/交接_给其他AI_20260718_P7完成_P8起点.md` **仅作考古**，不得覆盖 PASS final-validation。

## Goal 双轨北星（owner 终局 · 2026-07-23）

在本仓库跑 `/goal` 或长任务时默认：

- **A** 按剧本真实生图（Grok/Codex；隔离或正式以 STATUS 为准）  
- **B** 完善无限画布对生图的关键辅助：**角色 / 场景 / 站位** 及同级一致性（道具、光色、风格、节拍等）  
- **终局**：画布与代理生图互补到高契合，代理主要靠画布合同完成剧本出图  
- **禁句**：有序 formal PASS ≠「与无限画布产品 100% 完美契合」
## 硬边界（不可用社区技能覆盖）

- **P0–P10 软件目标已 final-validation PASS**：**禁止重做/重迁移/替换**下列 owner：  
  material-studio / studio-production / managed-project / studio-asset-binding / studio-binding-control /  
  panel-reference-resolution-core / studio-continuity* / studio-generation* / studio-generation-ledger /  
  studio-generation-review / checkpoint / **studio-production-dashboard** / studio-reliability / build-identity。
- **禁止因过期交接或本 Skill 旧文案「重建 P8」**。P8 驾驶舱已 PASS；≠ 自由无限白板产品 UI。
- 不正式批量生图、不浏览器/Artlist/Chrome 供应链、不上传付费外站、不发布部署、不 Git stage/commit/push（无用户授权）。
- 正式生图执行面：当前主供应为 **Codex**（`agent-imagegen` + `provider: codex`）；Grok 只保留离线合同兼容，用户已因无额度移出 live 验收。
- 正式工程 `projects/codex-ai-drama-studio` 是明确活动的受管工程（约 1.1GB、85 资产、541 单元、3246 宫格、1152 媒体），不是空库；禁止全盘扫描或旁路既有 owner 写入。
- 本机桌面入口为 `/Applications/AI 漫剧画布.app`；正式 Agent 链固定为 `get_capabilities` → `get_active_managed_studio_context` → readiness/冻结/派发 → `commit_agent_imagegen_result_bundle` → Review。
- 黄金面具唯一权威为 `/Users/hxx/Desktop/豆姐参考图.png`，SHA-256 `02e9438ecee038f7d14860da37cb315bf358db4a26fa224e342eee5b592b55a9`；`prop-d01-golden-mask` rev9/approved。旧 D01 Binding、连续性、冻结包和结果均为 stale 历史，禁止提升。
- 不覆盖既有 final-validation / 历史失败证据。

## 用户终态环（桌面看片 + MCP 同项目）

用户不查库、不每轮粘贴全书。Agent 先调用 `get_capabilities` 和 `get_active_managed_studio_context`，再消费 MCP Prompt `managed_studio_lock_generate_writeback`。写回必须使用 `commit_agent_imagegen_result_bundle` 原子登记 raw/labeled；不得继续走旧 `register_studio_generation_result` 主流程。

## 当前状态与优先级（P11–P14 已关账）

**不是 P8 或 P11–P14 重建。** 默认顺序：

1. 先读 `docs/当前开发交接.md` 与 Codex-primary final-validation，确认当前正式工程。  
2. 用户给出剧本或镜头范围时，优先执行新的 Codex 生产纵向切片，不重复建设已验收 owner。  
3. 只有真实生产暴露可复现缺陷时才进入研发修复；修复后重新走同摘要测试、安装版和新证据。

### P8 驾驶舱合同（已实现 owner，只维护不重做）

- Core：`src/core/studio-production-dashboard.ts`
- operations：`overview | units | unit | assets | appearances | queue`
- 响应必含：schemaVersion/kind/fingerprint、projectId/manifestFingerprint、Core `nextAction`、stable locator、currentness、有界 cursor
- 禁止返回：SQLite path、CAS path、bodyPath、媒体二进制
- 写入继续只走 `execute_command`
- UI 硬上限：≤36 单元摘要 / 选中 ≤6 宫格 / 当前格 ≤6 资产；分页替换 DOM；懒加载缩略图

## 必须复用的 owner（不要旁路）

| 能力 | Owner |
|------|--------|
| 规范资产/CAS/15s 单元 | `material-studio` / `studio-production` / `managed-project` |
| BindingSet / 消歧 | `studio-asset-binding` / `studio-binding-control` / `panel-reference-resolution-core` |
| 连续性/Review/checkpoint | `studio-continuity*` / `studio-generation-review` / `studio-generation-checkpoint` |
| 生成意图与结果账本 | `studio-generation` / `studio-generation-ledger` |
| 生产驾驶舱 | `studio-production-dashboard` |
| 可靠性 / 构建身份 | `studio-reliability` / `build-identity` |

## 社区技能在本仓库的正确用法

完整分析见 `docs/community-research/全网社区技能与规范分析_20260718.md`。

| 社区资源 | 可用于 | 禁止 |
|----------|--------|------|
| visual-skills / video-prompting | 提示词结构、角色表、分镜卡字段、戏剧学检查 | 直接当正式生成供应商脚本 |
| Big Prompt Hub 六步/一致性 | 内容字段设计、漂移 QA 清单 | 绕过 BindingSet / Review |
| short-drama / seedance-storyboard（本机镜像） | 剧本与 15s 分镜文案规范 | 模型把多格/字幕画进 raw |
| tldraw performance 规范 | 视口剔除、分页、LOD、稳定 zoom | 复制 tldraw 核心代码进生产；一次渲染全量宫格 |
| higgsfield browser skills | **仅作反面教材** | Playwright 网页自动化生图 |
| prompt-to-canvas (Excalidraw) | 产品示意图/架构板 | 替代 Studio 权威画布 |
| AGPL/GPL/CC-NC/非商用项目 | 需求/数据模型研究或独立进程适配器讨论 | 源码并入核心 |

## 验证完成门

任何「增量完成」声明必须：typecheck、定向测试、必要全量/构建、证据 JSON（**新文件名**）、交接更新。  
**软件增量完成 ≠ 正式成片 / 第三季生产完成 / 自由无限白板完成。**

## 不要做

- 恢复旧 Scanner / 旧 VueFlow ProjectIndex 当真源
- Dashboard 自建 DB/JSON 副本
- UI 自行推导 nextAction
- 把 Studio result 冒充 legacy Publication
- 无证据贯通 P3/P4/原镜
- 为「显得有工作」而重建已 PASS 的 P8–P10 合同面
