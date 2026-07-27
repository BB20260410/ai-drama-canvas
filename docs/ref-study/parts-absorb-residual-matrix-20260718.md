# 八库零件残余吸收矩阵 · 2026-07-18

> 对照 `docs/ref-study/01`–`08` 与当前源码；本轮仅落地 residual TAKE。

| # | 参考 | status | residual TAKE | 本库锚点 | 本轮 |
|---|------|--------|---------------|----------|------|
| 1 | LocalMiniDrama | **TAKE residual** | 工作流组「整组执行/重跑」UI 入口（runner 已有、画布未接） | `studio-canvas-workflow-runner` + `ManagedStudioCanvasView` | **本轮落地** |
| 1b | LocalMiniDrama | ALREADY | 节点面板 / status overlay / workflow 创建 / 布局持久化 | `ManagedStudioCanvasNode*` / `node-action-panel` / layout-store | — |
| 2 | Vue Flow | ALREADY | MiniMap + onlyRenderVisible + panOnDrag | `@vue-flow/minimap` / canvas | — |
| 2b | Vue Flow | SKIP | node-toolbar / resizer / pathfinding | — | 非刚需 |
| 3 | Jellyfish | **TAKE residual** | 驾驶舱准备清单稳定可达（选单元自动首格） | `StudioProductionDashboardView` + prep checklist | **本轮落地** |
| 3b | Jellyfish | ALREADY | 候选 confirm/ignore → Binding | `studio-binding-candidate-decision` / workbench | — |
| 4 | LumenX | **TAKE residual** | managedShell 下生成队列入口（cancel/jump/preview 已实现但壳外） | `MaterialStudioView` + `GenerationQueueView` | **本轮落地** |
| 4b | LumenX | ALREADY | 分桶 tabs / cancel / jump emit / preview | `studio-generation-queue-view` / GenerationQueueView | — |
| 5 | OTIO | ALREADY | export/import + probe | `editor.ts` / `studio-otio-capability-matrix` | — |
| 6 | OpenAssetIO | ALREADY | publication diagnostics 映射 | `studio-publication-preflight-diagnostics` | — |
| 6b | OpenAssetIO | SKIP | Python Manager 运行时 | — | 禁止 |
| 7 | TwitCanva | ALREADY | 边类型 ALLOWED 校验 | `studio-canvas-edge-validation` | — |
| 7b | TwitCanva | SKIP | 社交发帖链 | — | 红线 |
| 8 | OpenCut | **SKIP** | 整仓/Editor API | 书面关账 `absorb-opencut-skip` | 重写期 |

## 禁止

- 第二 SQLite / 平行 Dashboard 真源  
- 替换 P0–P10 owner  
- OpenCut 整并、TwitCanva 发帖  
