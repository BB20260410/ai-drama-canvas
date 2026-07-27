# P25 受管画布 UI 盘点与「保留/收纳/合并/移除」对照表

> 日期：2026-07-21（Asia/Shanghai）  
> 范围：`ManagedStudioCanvasView.vue`（2758 行）+ `ManagedStudioCanvasNode.vue`（235 行）+ 视图壳 `MaterialStudioView.vue` 与画布同屏部分。旧版生产画布（App.vue 内嵌）不在范围内，零改动。  
> 约束基线：约 40 个 `managed-canvas-*` testid 被合同测试与 smoke 脚本锁定（tests/ 22 个 + scripts/ 26 个，有交集），全部保留；smoke 直接点击的元素（toggle-edges / delete-edge / primary-start / flow-caption summary 等）保持可直接到达。

## 一、全量交互元素盘点

### A. 画布头部（canvas-header）
| # | 元素 | testid | 说明 |
|---|------|--------|------|
| A1 | eyebrow「AI 漫剧画布」 | — | 与壳头部产品标重复 |
| A2 | h2 工程名 | — | 与壳头部工程名重复 |
| A3 | 上下文行（单元 label·N 宫格 / 提示语） | — | 壳无此信息，独有 |
| A4 | 项目概览 details（资产/单元/宫格/媒体/文稿 5 计数） | managed-canvas-metrics、managed-canvas-text-doc-count | 默认 open；scale/p13 smoke 读 innerText，须保持计数可见 |
| A5 | 开始全部 N 格 | managed-canvas-primary-start | 主行动；p15 smoke 直接点击 |
| A6 | 刷新 | — | 手动全量刷新（P21 已有自动失效信号） |

### B. 状态条（result-strip）
| # | 元素 | testid | 说明 |
|---|------|--------|------|
| B1 | 状态点 + 状态文本 + 提示 | managed-canvas-result-status | p15 smoke 读文本 |
| B2 | 高级操作 details → 工作流工具条：已选宫格 N / 保存所选 / 执行最近工作流组 / 工作流 N / 最近标题 / 执行摘要 | managed-canvas-selection-count、create-workflow、run-workflow、workflow-count、last-workflow、workflow-run-summary、workflow-toolbar | 已收纳在 details，低频 |

### C. 错误条（canvas-error，条件出现）
p15 smoke 依赖 `.canvas-error` 文本与关闭按钮。保留原结构。

### D. 素材库（canvas-library aside）
| # | 元素 | 说明 |
|---|------|------|
| D1 | 库头（eyebrow + h3 + ×） | |
| D2 | 6 类 tabs（角色/场景/道具/剧本/提示词/分镜） | |
| D3 | 搜索框（资产类） | |
| D4 | 列表项 + 添加/移除按钮（pin-button） | |
| D5 | 分页 上一页/下一页 | managed-canvas-assets-prev/next、managed-canvas-units-prev/next |
| D6 | 季/集筛选 select（分镜 tab） | |

### E. 浮动工具（floating-tools，画布左上）
| # | 元素 | testid | 说明 |
|---|------|--------|------|
| E1 | 添加 + 弹出菜单（6 类） | managed-canvas-add-node | 高频 |
| E2 | 素材库开关 | managed-canvas-open-library | 高频 |
| E3 | 连线模式 | managed-canvas-connect-mode | 高频 |
| E4 | 帮助 | — | 低频但新手必要 |

### F. 底栏（bottom-tools，画布底部居中）— 当前 12+ 件，主要减灾区
| # | 元素 | testid | 频率判定 |
|---|------|--------|----------|
| F1 | 适配 | — | 高频（亦可由 Controls fit 达成） |
| F2 | 撤销 | managed-canvas-undo | 高频，p23/24 smoke 点击 |
| F3 | 重做 | managed-canvas-redo | 高频，p23/24 smoke 点击 |
| F4 | 对齐 6 钮（≥2 选） | managed-canvas-align-tools | 情境中频 |
| F5 | 分布 2 钮（≥3 选） | （同上组内） | 情境低频 |
| F6 | 已选 N 节点 | — | 情境提示 |
| F7 | 隐藏/显示连线 | managed-canvas-toggle-edges | p15 smoke 直接点击两次 → 必须保持默认直接可见 |
| F8 | 删除所选连线（选线时出现） | managed-canvas-delete-edge | p15 smoke 直接点击 → 保持情境直出 |
| F9 | 隐藏/显示小地图 | — | 低频（MiniMap 本体 managed-canvas-minimap 默认开，deep-absorb smoke waitForSelector） |
| F10 | 查看全部/回到工作流 | — | 低频 |
| F11 | 清空画布视图（workflow 模式，二次确认） | managed-canvas-clear-view | 低频；**p15 smoke 依赖**（getByRole 直点 :380-388）→ 例外常驻 |

### G. 诊断条（flow-caption details，右下）
managed-canvas-dom-counts / managed-canvas-thumb-count / managed-canvas-layout-status。scale smoke 先点击 `details.flow-caption > summary` 再读 → 保持 details 形态即可。低频。

### H. 帮助卡（help-card）
低频，保留。

### I. 检查器（canvas-inspector aside）
×关闭、五类模板（asset/unit/script/prompt/panel）、权威缩略图（managed-canvas-inspector-thumb）、出场时间线+分页（managed-canvas-appearances、-prev、-next）、正文预览（managed-canvas-text-body）、诊断 details、节点操作面板（managed-canvas-node-action-panel、managed-canvas-action-*，p23/24 smoke 点击 action-open-binding / action-focus-unit / action-freeze-dispatch / action-close-panel / action-open-dashboard）。全部保留。

### J. VueFlow 内建
Controls（放大/缩小/适配，左下）、MiniMap（右下）。保留。

### L. 节点卡片（ManagedStudioCanvasNode.vue）— 合同锁定项
| # | 元素 | testid | 锁定内容 |
|---|------|--------|----------|
| L1 | 左连接点「＋」（target） | managed-canvas-node-left-plus、managed-canvas-panel-target | **26px 尺寸、overflow:visible、`>＋</span>`、role=button/tabindex/Enter+Space 键盘**（managed-studio-canvas-ui.test.ts:169-170,190；p15 smoke :204-212,277-304 focus+键盘+点击） |
| L2 | 右连接点「＋」（source） | managed-canvas-node-right-plus、managed-canvas-input-source | 同上 |
| L3 | 缩略图 / 占位 kindMark | managed-canvas-node-thumb | restyle 只动配色排版 |
| L4 | busy 遮罩 | — | role=status 保留 |

### M. 可访问名称/文本依赖（testid 之外的隐性锁）
| 文本 | 依赖点 |
|------|--------|
| 「适配」按钮文案 | p15 smoke :225,274；p23/24 探针 src/main/index.ts:878 按文本点击 |
| 「清空画布视图」/「再点一次确认清空」 | p15 smoke :380-386 getByRole 直点+断言文案消失 |
| 「帮助」（.floating-tools 内）+ dialog「画布帮助」+「关闭帮助」 | p17 smoke :178-180 |
| 「已选 N 节点」（.selection-count） | p23/24 探针 src/main/index.ts:929 正则 `已选 (\d+) 节点` 读数 |
| 图标化改造必须保留可见文本或等价 aria-label | 全表适用 |

### K. 视图壳同屏区（MaterialStudioView，仅 canvas 模式相关）
| # | 元素 | 说明 |
|---|------|------|
| K1 | 壳头部：产品标 + 工程名 | 与 A1/A2 重复 |
| K2 | 步骤导航 1剧本→5审片 | 生产语义导航，保留 |
| K3 | 视图切换（无限画布/驾驶舱/Agent 连接/帮助·备份） | 保留 |
| K4 | 唯一下一步卡 + 「继续」主按钮 | 生产闭环关键，保留；与 A5 语义不同（Core nextAction vs 画布派发预检） |

## 二、分类对照表

### 保留并前置（高频核心）
| 元素 | 处置 |
|------|------|
| 开始全部 N 格（A5） | 头部唯一金色主按钮，前置右侧 |
| 添加（E1）、素材库（E2）、连线（E3） | 浮动工具前三件，图标+文字，保持 |
| 撤销/重做（F2/F3） | 底栏最左，配合 ⌘Z/⌘⇧Z |
| 适配（F1） | 底栏保留 |
| 对齐/分布（F4/F5） | 保留，≥2/≥3 情境出现；样式图标化 |
| 删除所选连线（F8） | 保留，选线情境直出 |
| 已选 N（F6/B2 内） | 保留提示 |
| 素材库全部（D1–D6） | 保留，仅视觉刷新 |
| 检查器全部（I） | 保留，仅视觉刷新 |
| 状态条（B1） | 保留 |
| 项目概览计数（A4） | 保留常显（smoke 依赖），改紧凑横向小字条 |
| 错误条（C） | 保留 |
| MiniMap / Controls（J） | 保留；颜色随主题 |

### 收纳（低频 → 菜单/二级）
| 元素 | 处置 |
|------|------|
| 隐藏/显示连线（F7） | **例外保留在底栏**：p15 smoke 无菜单操作直接点击两次，入菜单会破坏验收；仅样式收敛 |
| 小地图开关（F9） | 收入底栏「视图」菜单 |
| 查看全部/回到工作流（F10） | 收入「视图」菜单 |
| 清空画布视图（F11） | **例外保留在底栏**（workspaceMode==='workflow' 情境直出，二次确认不变）：p15 smoke 用 `getByRole("button", { name: "清空画布视图"/"再点一次确认清空" })` 无菜单操作直接点击（ui-p15-simple-canvas-smoke.ts:380-388），入菜单即超时——与 F7 同性质依赖 |
| 刷新（A6） | 收入「视图」菜单 |
| 主题切换（新增） | 收入「视图」菜单：浅色（默认）/深色/米色 三套皮肤 |
| 高级操作（B2） | 维持 details 收纳，弱化入口样式 |
| 诊断详情（G、I 内） | 维持 details 收纳，弱化入口样式 |

### 合并（去重）
| 元素 | 处置 |
|------|------|
| A1 eyebrow + A2 h2 工程名 vs K1 壳头部产品标+工程名 | 画布头移除 eyebrow 与 h2（壳已完整展示身份）；A3 上下文行保留并提为头部唯一左侧内容（无 testid 依赖，合同安全） |
| A4 项目概览 details（默认 open） | 合并进头部右侧为紧凑计数条（保留 details+open 结构语义与全部 testid，样式收敛） |
| 适配（F1）vs VueFlow Controls fit | 底栏保留「适配」主路径；Controls 不动（全局共享样式，且旧画布红线不动） |

### 移除（死入口/无替代冗余）
无。全部按钮均有实际功能；不提供无替代路径的移除。

## 三、现状问题清单（设计输入）

1. **双头冗余**：壳头（产品标+工程名+步骤+继续）与画布头（eyebrow+工程名+概览+开始）同屏，身份区重复、两个金色主按钮抢焦点。
2. **仅深色硬编码**：全部颜色十六进制写死（#0f1110/#161817/#d7b85c…），无主题系统；全局 styles.css `color-scheme: dark`。
3. **字号过小**：8–11px 遍布（计数 8px、按钮 9–10px、正文 10–11px），中文可读性差。
4. **边框滥用**：每个按钮/面板/条目 1px 描边（#383c39 等），视觉噪音大。
5. **底栏拥挤**：12+ 件混排 9px 小字，情境项与常驻项不分。
6. **节点组件**：深色硬编码、188px 固定宽、12px 标题，信息层级弱。
7. **诊断/高级入口视觉过重**：details 入口与普通文本无层级区分。
