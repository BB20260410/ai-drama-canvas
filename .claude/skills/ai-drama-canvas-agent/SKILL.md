---
name: ai-drama-canvas-agent
description: 在「AI 漫剧无限画布」仓库内做软件研发时强制使用。覆盖 P0–P10 已关账边界、owner 复用、驾驶舱只读合同、MCP/CAS/门禁、社区技能映射、参考项目差距审计。触发：无限画布、StudioProductionDashboard、BindingSet、连续性、宫格、managed studio、P8–P10、参考审计。
---

# AI 漫剧无限画布 · 研发 Agent 规范

## 先读（按序）

1. `docs/当前开发交接.md`（**唯一实时交接**）
2. `AGENTS.md`
3. `docs/验证报告_20260718_P0至P10最终关账.md` + `docs/evidence/final-validation-20260718-p8|p9|p10-*.json`
4. 残差层：`docs/验证报告_20260718_P9R_P10R重验收关账.md` / `*p9r*` / `*p10r*`
5. `docs/community-research/INDEX.md`
6. `docs/开源项目借鉴审计_2026-07-13.md` 与（若存在）最新 `docs/参考项目增量差距审计_*.md`

历史交接 `docs/交接_给其他AI_20260718_P7完成_P8起点.md` **仅作考古**，不得覆盖 PASS final-validation。

## 硬边界（不可用社区技能覆盖）

- **P0–P10 软件目标已 final-validation PASS**：**禁止重做/重迁移/替换**下列 owner：  
  material-studio / studio-production / managed-project / studio-asset-binding / studio-binding-control /  
  panel-reference-resolution-core / studio-continuity* / studio-generation* / studio-generation-ledger /  
  studio-generation-review / checkpoint / **studio-production-dashboard** / studio-reliability / build-identity。
- **禁止因过期交接或本 Skill 旧文案「重建 P8」**。P8 驾驶舱已 PASS；≠ 自由无限白板产品 UI。
- 不正式批量生图、不浏览器/Artlist/Chrome 供应链、不上传付费外站、不发布部署、不 Git stage/commit/push（无用户授权）。
- 正式生图执行面：Agent 侧 **Codex / Grok**（`agent-imagegen` + `provider: codex|grok`）。
- 隔离工程 `projects/codex-ai-drama-studio` 保持空库；禁止暗扫第三季与权威参考图。
- 不覆盖既有 final-validation / 历史失败证据。

## 当前研发优先级（基线校正后）

**不是 P8 重建。** 默认顺序：

1. 外部参考项目 **增量差距审计**（先矩阵再代码）  
2. 残差增量中经证据确认的 **单一切片**（扩展既有 owner）  
3. 可选：Electron 大规模 smoke、Codex 真实 canary、SQL keyset 等

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
