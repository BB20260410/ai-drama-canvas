# TASKS · 残留任务清账 2026-07-25

## software_goal: runtime-perf-memory-20260825

- status: `in_progress`（W1-A/B 已落地；W1-C 待审查后勾）
- plan: `docs/PLAN_运行速度与内存占用长期执行_20260825.md`
- [x] Wave 0：计划 + 调用点表 + 红线 + 证据（外部模型席本环境未跑）
- [x] Wave 1-A：`getApprovedTimelineProjection` 默认 `fastMode ?? true`
- [x] Wave 1-B：full 仅 CLI `report-approved-timeline-full` + 投影 `durationMs`；日常诊断保持 fast
- [x] Wave 1-C：定向测试 + typecheck:app
- [x] Wave 2-A：`unitIds`/`limit` 有界投影（上限 36；省略=整集）
- [x] Wave 2-B：画布可见页只请求 unitIds
- [x] Wave 2-D：账本/计划风暴并入单 rAF
- [ ] Wave 2-C/E/F：P7 有界对照（Darwin）；MiniMap 降级；切工程清 LRU
- [ ] Wave 3：只读投影改 `inspectManagedProjectReadOnly`；earliest 去 per-unit snapshot；ssl5 不二次 earliest
- [ ] Wave 4：MCP/Main 冷域动态 import（editor / story+mammoth / novel / video-package；抄 Main IPC `await import`；禁拆 command-bus 写路径）
- [ ] Wave 5：列表只绑缩略图；legacy thumb 不先整文件读入；审片默认 thumb；derivative 不校源全 SHA
- [ ] Wave 6：度量关账；安装版 T23 仅 owner 点名
- [ ] 禁止：重建 P0–P14、无证据 SQL 批量化、N124 CV、全盘扫正式工程

## software_goal: unit-grid-brief-contract-w1-20260825

- status: `completed_slice`
- [x] `src/core/unit-grid-brief-contract.ts` 从 freeze pack 组装 7 槽
- [x] `buildStudioUnitGridAgentImagegenBrief` 挂 `promptContract`（不改 renderedPrompt）
- [x] `docs/prompts/*` 模板 + 注入说明
- [x] 定向测试 + typecheck:app
- [x] 证据 JSON 新文件名 `docs/evidence/unit-grid-brief-contract-v1-20260825.json`
- [ ] live canary（隔离工程 freeze→生图）— 需 owner 指定单元与额度，本切片不做

## software_goal: oss-public-github-20260824

- status: `completed`
- [x] 本地全面检查（typecheck:app、fast tests、密钥扫描、gitignore）
- [x] Apache-2.0 LICENSE / NOTICE / README / CONTRIBUTING / SECURITY / CoC / CI
- [x] 推送到 `BB20260410/ai-drama-canvas` 公开仓库
- [x] 读取 GitHub 建议：CI 改 macOS、Dependabot 升级、CodeQL
- [x] macOS CI 通过（32714879168 / 32740441909）；打开 Dependabot 告警 0
- [x] 关闭会破坏构建的 Dependabot PR（TS 7 / Vite 8 / 顶层 esbuild）
- [x] CodeQL 首轮跑完 success（32740441904，3h20m）
- [x] 修 CodeQL 28 条告警（ReDoS / executeJavaScript / 多项式正则 / 标签剥离 / 恒等替换 / 栈泄露）
- [x] 本地 `npm test` 0 失败：测试前补齐 Electron 二进制与 dist-mcp

## software_goal: character-canvas-pack-20260821

- status: `completed_slice`
- [x] 音色身份绑定规范角色资产 + CAS 音频 SHA
- [x] 画布角色页上传图片/音频入库
- [x] 钉到画布时自动带出参考图节点和音频节点
- [x] 无窗口定向测试 + typecheck:app PASS

## software_goal: oss-gap-n1-scene-prop-20260821

- [x] 8 路开源调研合成 `docs/参考项目增量差距审计_20260821.md`
- [x] 场景/道具对称入库（不绑 VoiceIdentity）
- [x] N2 画布音频节点试听
- [x] N3 库拖到落点钉选
- [x] N4 角色多视图槽
- [x] N5 阅读器联动 earliest span
- [x] N6 ⌘G 命名空间组（spatialGroups + Vue Flow parentNode）
- [x] N7 检查器角色 CAS 音频原生试听（mutex + busy 早退）
- [x] N8 入库/检查器/库行别名接线
- [x] N9 Shift+1 / Controls 走 fitCanvas（覆盖默认 fitView）
- [x] N10 Shift+0 → zoomTo(1)
- [x] N11 Shift+2 适配选区（无选区空操作）
- [x] N12 入库可选 description（空则模板句）
- [x] N13 Delete/Backspace 卸钉或删所选连线
- [x] N14 可选 24px 网格吸附（默认关，不开 snapToGrid）
- [x] N15 Arrow 1px / Shift+Arrow 24px 微移
- [x] N16 ⌘A 全选当前 nodes
- [x] N17 Space+左键拖平移（默认框选不变）
- [x] N18 Escape 关弹层后再清选区
- [x] N19 Shift+⌘A 反选
- [x] N20 Alt+Arrow 走 applyAlign
- [x] N21 Alt+H/V 居中，Alt+Shift+H/V 均分
- [x] N22 Shift+E 切连线显隐
- [x] N23 Shift+M 切小地图
- [x] N24 Shift+W 切工作流过滤
- [x] N25 Shift+T / Shift+Alt+T 时间线重排
- [x] N26 F5 走 refreshAll（preventDefault）
- [x] N27 无修饰 C 切连线模式
- [x] N28 F1 开合帮助卡
- [x] N29 无修饰 A 开合添加菜单
- [x] N30 无修饰 L 开合素材库
- [x] N31 Shift+L 开合剧本资源
- [x] N32 F6 核对外部来源
- [x] N33 Shift+D 循环画布主题
- [x] N34 ⌘F 聚焦进度搜索
- [x] N35 Enter 定位唯一搜索命中
- [x] N36 F3/Shift+F3 循环搜索命中
- [x] N37 查询非空 Escape 先清空
- [x] N38 空查询 Escape 先失焦
- [x] N39 查询框 Alt+Arrow 循环审片筛选
- [x] N40 筛选 Escape 回查询框
- [x] N41 `[`/`]` 循环宫格芯片
- [x] N42 Home/End 定位宫格首末芯片（输入框保持原生）
- [x] N43 宫格条 roving tabindex（Arrow/Home/End 只移焦）
- [x] N44 芯片焦点 PageUp/PageDown 跳 10 格夹端点
- [x] N45 无芯片焦点 PageUp/PageDown 跳 10 格夹端点
- [x] N46 单元轨 Page 跳 10 条 selectUnit（不翻页）
- [x] N47 单元轨/分页钮 Alt+Page 翻页
- [x] N48 单元轨 Arrow/Home/End roving tabindex
- [x] N49 素材可见窗 Arrow/Home/End roving tabindex
- [x] N50 剧本/提示词列表 Arrow/Home/End roving tabindex
- [x] N51 媒体库行 Arrow/Home/End roving tabindex（Enter 不钉选）
- [x] N52 媒体库 Alt+Page 翻页
- [x] N53 素材库 Alt+Page 翻页
- [x] N54 全局资源 Alt+Page 翻页
- [x] N55 检查器出场 Alt+Page 翻页（不 focusAppearance）
- [x] N56 检查器出场行 Arrow/Home/End roving tabindex（Enter 仍 focusAppearance）
- [x] N57 全局资源卡 Arrow/Home/End roving tabindex（Enter 不写入）
- [x] N58 节点操作钮 Arrow/Home/End roving tabindex（跳过 disabled）
- [x] N59 素材库 tabs Arrow/Home/End roving tabindex（Enter 仍 openLibraryFor）
- [x] N60 全局资源 tabs Arrow/Home/End roving tabindex（跳过 loading disabled）
- [x] N61 添加菜单 Arrow/Home/End roving tabindex（Enter 仍 chooseAddKind）
- [x] N62 浮动工具栏 Arrow/Home/End roving tabindex（不调用 toggle*）
- [x] N63 底部视图工具 Arrow/Home/End roving tabindex（跳过 disabled）
- [x] N64 视图菜单项 Arrow/Home/End roving tabindex（打开后焦第一可用项）
- [x] N65 视图主题 radio Arrow/Home/End roving tabindex（Enter 仍 setCanvasTheme）
- [x] N66 受管画布 Vue Flow Controls Arrow/Home/End roving tabindex（不抢 N9）
- [x] N67 故事图 Vue Flow Controls Arrow/Home/End roving tabindex（不改 connecting）
- [x] N68 遗留生产画布 Vue Flow Controls Arrow/Home/End roving tabindex（不静态装入 VueFlow）
- [x] N69 受管 MiniMap Arrow 平移视口（不抢 N15/N23）
- [x] N70 帮助卡打开焦关闭钮，Tab 不逃出（不抢 N28/N18）
- [x] N71 MiniMap 节点 data-node-id roving + Enter 选中（禁止 HTML id）
- [x] N72 连线横幅退出钮 testid，关闭后焦回连线钮
- [x] N73 检查器关闭钮 testid + 关闭后焦回画布（aside 非 dialog）
- [x] N74 导演面板打开焦过滤框，Tab 不逃出
- [x] N75 素材库/剧本资源关闭钮 testid，关闭后焦回开库钮
- [x] N76 错误横幅关闭钮 testid + 关闭后焦回画布（Escape 不清错误）
- [x] N77 清空二次确认后焦回画布（无 window.confirm）
- [x] N78 帮助关闭钮 testid，click 归还触发钮
- [x] N79 视图菜单关闭后焦回 summary（帮助/添加归还优先）
- [x] N80 画布诊断 details summary testid
- [x] N81 检查器诊断 details summary testid
- [x] N82 素材库详情栏诊断 summary testid（不铺列表行）
- [x] N83 审片下一动作诊断 summary testid
- [x] N84 生成控制技术消息诊断 summary testid
- [x] N85 审片头栏诊断 summary testid
- [x] N86 审片资产卡诊断 summary testid
- [x] N87 审片冲突卡诊断 summary testid

## software_goal: 24h-perf-interaction-20260821

- status: `in_progress`
- deadline: `2026-08-22T11:30:00+08:00`
- silent: 后台 scheduler 15m、无可见窗口；一轮做完立刻下一轮
- journal: `.workqueue/continuous-iteration-20260821.md`

### 迭代 P1（完成）
- [x] 无窗口基线 40 tests PASS
- [x] 受管画布侧栏 `.library-list li` content-visibility + 合同；managed-studio-canvas-ui 39 PASS
- [x] 后台静默 scheduler `01a0225f7f21`

### 迭代 P2（完成）
- [x] MaterialStudio `.material-entry` 宫格/列表 content-visibility + 源码合同；4 files / 54 tests PASS；`typecheck:app` PASS

### 迭代 P3（完成）
- [x] StoryWorkbench `.chapter-list>button` content-visibility + 源码合同；7/7 PASS；`typecheck:app` PASS

### 迭代 P4（完成）
- [x] CanonicalAssetLibrary `.canonical-card` content-visibility + 源码合同；1/1 PASS；`typecheck:app` PASS

### 迭代 P5（完成）
- [x] GenerationQueue `.job-row` content-visibility + 源码合同；6/6 PASS；`typecheck:app` PASS

### 迭代 P6（完成）
- [x] Dashboard `.queue-entry` + 同型 `.unit-entry` content-visibility + 源码合同；12/12 PASS；`typecheck:app` PASS

### 迭代 P7（完成）
- [x] NovelStudio `.volume-section > button` content-visibility + 源码合同；12/12 PASS；`typecheck:app` PASS

### 迭代 P8（完成）
- [x] NarrativeAdaptation 事实/节拍/审核队列 content-visibility + 源码合同；3/3 PASS；`typecheck:app` PASS

### 迭代 P9（完成）
- [x] StoryWorkbench `.event-strip>button` content-visibility + 源码合同；8/8 PASS；`typecheck:app` PASS

### 迭代 P10（完成）
- [x] NarrativeAdaptation unit-list / provider-list / shot-list content-visibility + 源码合同；4/4 PASS；`typecheck:app` PASS

### 迭代 P11（完成）
- [x] Dashboard appearances 行 content-visibility + 源码合同；13/13 PASS；`typecheck:app` PASS

### 迭代 P12（完成）
- [x] ScriptWorkbench `.document-list button` content-visibility + 源码合同；3/3 PASS；`typecheck:app` PASS

### 迭代 P13–P15（完成）
- [x] NovelStudio search-results 48px；StoryWorkbench source-row 56px；Continuation article 56px + 共享 queue/memory/skill 索引 64px

### 迭代 P16–P21（完成）
- [x] NovelStudio memory-list 48px
- [x] ProductionDesign bible-list 56px
- [x] GenerationControl unit-rail 56px + panel-list 96px
- [x] ContinuityTimeline track-list 72px
- [x] MultimediaTimeline unit-list 56px
- [x] GlobalResource resource-card 152px；Inspector appearance-list 40px；TaskCenter event-list 54px
- [x] 11 files / 112 tests PASS；`typecheck:app` PASS

### 迭代 P22（完成）
- [x] PanelReference resolution-row/derived-card；Binding unit-row；ProjectCenter project-row；ScriptMediaAlign document-card；ProductionDesign voice/registry
- [x] 5 files / 14 tests PASS

### 迭代 P23（完成）
- [x] ProductionDesign storyboard-table 行 62px content-visibility；production-design-view 6/6 PASS；`typecheck:app` PASS

### 迭代 P24（完成）
- [x] StudioContinuityReview history/timeline/conflict/batch 网格 content-visibility；12 tests PASS；`typecheck:app` PASS

### 迭代 P25（完成）
- [x] ContinuityTimeline span-row 72px；ReviewStudio history 56px；ScriptMediaAlign reader-nav 28px；GenerationControl plan-node 32px
- [x] 6 files / 31 tests PASS；`typecheck:app` PASS；digest `fd5574a7…`

### 迭代 P26（完成）
- [x] ProductionDesign 分镜构建/迁移/核验 + sheets/enqueue/render handler fail-closed；7/7 PASS

### 迭代 P27（完成）
- [x] NovelStudio 新建卷/章/改名；VideoEditor 创建工程 handler fail-closed

### 迭代 P28（完成）
- [x] NovelStudio 选卷/翻页 busy 早退，不踩保存中 busy；36 tests PASS；`typecheck:app` PASS；digest `5d1b25e8…`

### 迭代 P29（完成）
- [x] VideoEditor `selectEditProject` 在 creating/editorWriteBusy 时 fail-closed；select 禁用并还原 currentId

### 迭代 P30（完成）
- [x] VideoEditor addMedia / addSubtitle / addOverlayTrack 写入中 fail-closed；dirty-guard 15/15 PASS；digest `6231cd7a…`

### 迭代 P31（完成）
- [x] VideoEditor openCreate / removeTrack 写入中 fail-closed

### 迭代 P32（完成）
- [x] VideoEditor addNestedTimeline / refreshNestedTimeline 写入中 fail-closed；dirty-guard 17/17 PASS；digest `efb4b990…`

### 迭代 P33（完成）
- [x] MaterialStudio continueFromCore / openCreateDialog pendingAction 早退；创建提交任意 pending 禁用；GlobalResource runReuse 合同；28 tests + typecheck:app PASS；digest `f1995faa…`

### 迭代 P34（完成）
- [x] DesktopSupport 修复/备份/恢复/刷新 busy title + handler 早退；Canonical 只读跳过；3 tests + typecheck:app PASS；digest `a931852c…`

### 迭代 P35（完成）
- [x] Higgsfield queueVideo busy 早退 + title；App.vue scanNow 拦截 projectOperationBusy；13 tests + typecheck:app PASS；digest `682c9ac5…`

### 迭代 P36（完成）
- [x] queueHiggsfieldImage 拦截 generationActionsBlocked；按钮 disabled + title；11 tests + typecheck:app PASS；digest `7036743e…`

### 迭代 P37（完成）
- [x] persistStudioContext in-flight + pending 合并最新焦点；切工程清 pending；13 tests + typecheck:app PASS；digest `f4ddb6e6…`

### 迭代 P38（完成）
- [x] createCanvasEntity / editCanvasEntity / toggleLinkMode busy fail-closed；12 tests + typecheck:app PASS；digest `aab33680…`

### 迭代 P39（完成）
- [x] Inspector `.artifact-row` content-visibility 40px；3+2 tests + typecheck:app PASS；digest `12f96712…`

### 迭代 P40（完成）
- [x] 扫描剩余无 CV Vue / busy：无自动项，未改产品

### 迭代 P41（完成）
- [x] ManagedStudioCanvas `.global-resource-card` 128px；TaskCenter `.task-pack li` 32px；先红后绿 47 tests + typecheck:app PASS；digest `c8a4d39d…`

### 迭代 P42（完成）
- [x] CanonicalAssetLibrary `.authority-entry,.version-entry` 40px；2/2 tests + typecheck:app PASS；digest `d117dda1…`

### 迭代 P43（完成）
- [x] 扫描 overflow:auto 未剔除行 / busy：无自动项，未改产品

### 迭代 P44（完成）
- [x] 扫描 inspector 第二列表 / 写入守卫：无自动项，未改产品

### 迭代 P45（完成）
- [x] 扫描 styles.css / Higgsfield + 52 条已有剔除合同 PASS；未改产品

### 迭代 P46（完成）
- [x] ContinuityReview `removeHeadAnnotation` fail-closed + busy title；13 tests + typecheck:app PASS；digest `ab18098e…`

### 迭代 P47（完成）
- [x] 扩大 busy 扫描同型写入：无自动项，未改产品

### 迭代 P48（完成）
- [x] 扫描箭头/方法 busy 赋值：无自动项，未改产品

### 迭代 P49（完成）
- [x] VideoEditor `cancelRender` fail-closed + busy title；18 tests + typecheck:app PASS；digest `90d93610…`

### 迭代 P50（完成）
- [x] 扫描 cancel/delete/remove/release 写 IPC：无自动项，未改产品

### 迭代 P51（完成）
- [x] VideoEditor `resolveRecovery` fail-closed + busy title；19 tests + typecheck:app PASS；digest `2eec8cbb…`

### 迭代 P52（完成）
- [x] NarrativeAdaptation `replaceFailedBatch` / `batchReview` prompt 前 fail-closed；5 tests + typecheck:app PASS；digest `43d9e35b…`

### 迭代 P53（完成）
- [x] StudioGenerationControl `runPlanAction` confirm 前 fail-closed；8 tests + typecheck:app PASS；digest `c8e7f5c1…`

### 迭代 P54（完成）
- [x] StoryWorkbench `pickSource` fail-closed + busy title；10 tests + typecheck:app PASS；digest `7a286ac2…`

### 迭代 P55（完成）
- [x] 扫描剩余 click→pick 写入口：无自动项，未改产品；digest 仍 `7a286ac2…`

### 迭代 P56（完成）
- [x] ManagedStudioCanvas `pickCharacterImage/Audio` fail-closed；44 tests + typecheck:app PASS；digest `d2b24727…`

### 迭代 P57（完成）
- [x] ImportWizard `pickingRoot` + MaterialStudio pick-package fail-closed；6 tests + typecheck:app PASS；digest `40995ad8…`

### 迭代 P58（完成）
- [x] App.vue `importProject`/`chooseManagedParentRoot` pickingProjectRoot fail-closed；p13 9/9 + typecheck:app PASS；digest `ce67d3d0…`

### 迭代 P59（完成）
- [x] 扫描 P54–P58 之外剩余 pick：无自动项，未改产品；digest 仍 `ce67d3d0…`

### 迭代 P60（完成）
- [x] ProjectCenter busy 含 picking；App 传入 pickingProjectRoot；p13 10/10 + typecheck:app PASS；digest `86c8cf90…`

### 迭代 P61（完成）
- [x] NovelStudio `.candidate-list button` content-visibility 48px；17 tests + typecheck:app PASS；digest `05c3757a…`

### 迭代 P62（完成）
- [x] NovelStudio `.volume-toggle` 40px + Continuation `.recovery-banner article` 48px；29 tests + typecheck:app PASS；digest `ce917cd3…`

### 迭代 P63（完成）
- [x] MultimediaTimeline `.track-entry` content-visibility 82px；10 tests + typecheck:app PASS；digest `6c6da1e7…`

### 迭代 P64（完成）
- [x] 扫描剩余无 CV 滚动行 / busy：无自动项，未改产品；digest 仍 `6c6da1e7…`

### 迭代 P65（完成）
- [x] 连续两轮无自动项：开源对标附录 N2 规格；未改产品；digest 仍 `6c6da1e7…`

### 迭代 P66（完成）
- [x] digest 漂 `ee8a9c5c…`（N2 画布音频落地中）；未改 24h-perf 产品；邻接 68 tests PASS

### 迭代 P67（完成）
- [x] digest 仍 `ee8a9c5c…`；非画布无新 CV/busy 红测；未改产品；113 tests PASS

### 迭代 P68（完成）
- [x] CanvasNode busy 暂停音频；46 tests + typecheck:app PASS；digest `5d716fa8…`

### 迭代 P69（完成）
- [x] digest 漂 `ccac908b…`（N3 库拖落地中）；未改 24h-perf 产品；邻接 68 tests PASS

### 迭代 P70（完成）
- [x] digest 仍 `ccac908b…`；N3 已关且拖放 fail-closed；未改产品；115 tests PASS

### 迭代 P71（完成）
- [x] CanvasNode playbackUrl 变化时 pause；48 tests + typecheck:app PASS；digest `e522506f…`

### 迭代 P72（完成）
- [x] 画布音频节点互斥 play（mutex 模块 + Node `@play`）；5+48 tests + typecheck:app PASS；digest `8ad68447…`

### 迭代 P73（完成）
- [x] MaterialStudio / MultimediaTimeline 原生音频接入画布互斥；21 tests + typecheck:app PASS；digest `7c953b7d…`

### 迭代 P74（完成）
- [x] busy/pendingAction/bindBusy 时原生 play 立即 pause；72 tests + typecheck:app PASS；digest `f13795bb…`

### 迭代 P75（完成）
- [x] busy 时禁用原生音频 pointer-events；75 tests + typecheck:app PASS；digest `870f970a…`

### 迭代 P76（完成）
- [x] 扫描剩余 CV/busy：无自动项，未改产品；digest 仍 `870f970a…`；75 tests + typecheck:app PASS

### 迭代 P77（完成）
- [x] 6b 附录：N5=`mod+e`→已有 `focusEarliestUnit`；未改产品；digest `d4197f88…`

### 迭代 P78（完成）
- [x] N5 已关；无新 CV/busy 红测，未改产品；digest `25c1df9c…`；81 tests + typecheck:app PASS

### 迭代 P79（完成）
- [x] 6b 附录：N6=⌘G + Vue Flow parentId + 遗留 group；未改产品；digest 仍 `25c1df9c…`

### 迭代 P80（完成）
- [x] 无新 CV/busy 红测，未改产品；digest 仍 `25c1df9c…`；81 tests + typecheck:app PASS

### 迭代 P81（完成）
- [x] 6b 附录：N7=检查器/库行试听走 mutex；earliest 仍 N6；未改产品；digest 仍 `25c1df9c…`

### 迭代 P82（完成）
- [x] 无新 CV/busy 红测，未改产品；digest 仍 `25c1df9c…`；81 tests + typecheck:app PASS

### 迭代 P83（完成）
- [x] 6b 附录：N8=画布入库/检查器别名接线；earliest 仍 N6；未改产品；digest 仍 `25c1df9c…`

### 迭代 P84（完成）
- [x] 无新 CV/busy 红测，未改产品；digest 仍 `25c1df9c…`；81 tests + typecheck:app PASS

### 迭代 P85（完成）
- [x] 6b 附录：N9=`Shift+1`/Controls → 已有 `fitCanvas()`；earliest 仍 N6；未改产品；digest 仍 `25c1df9c…`

### 迭代 P86（完成）
- [x] 无新 CV/busy 红测，未改产品；digest 仍 `25c1df9c…`；81 tests + typecheck:app PASS

### 迭代 P87（完成）
- [x] 6b 附录：N10=`Shift+0` → `zoomTo(1)`；earliest 仍 N6；未改产品；digest 仍 `25c1df9c…`

### 迭代 P88（完成）
- [x] 无新 CV/busy 红测，未改产品；digest 仍 `25c1df9c…`；81 tests + typecheck:app PASS

### 迭代 P89（完成）
- [x] 6b 附录：N11=`Shift+2` 适配所选节点；earliest 仍 N6；未改产品；digest 仍 `25c1df9c…`

### 迭代 P90（完成）
- [x] 无新 CV/busy 红测，未改产品；digest 仍 `25c1df9c…`；81 tests + typecheck:app PASS

### 迭代 P91（完成）
- [x] 6b 附录：N12=入库可选 description；earliest 仍 N6；未改产品；digest 仍 `25c1df9c…`

### 迭代 P92（完成）
- [x] 无新 CV/busy 红测，未改产品；digest 仍 `25c1df9c…`；81 tests + typecheck:app PASS

### 迭代 P93（完成）
- [x] 6b 附录：N13=Delete/Backspace 卸钉走 togglePinnedNode；earliest 仍 N6；未改产品；digest 仍 `25c1df9c…`

### 迭代 P94（完成）
- [x] 无新 CV/busy 红测，未改产品；digest 仍 `25c1df9c…`；81 tests + typecheck:app PASS

### 迭代 P95（完成）
- [x] 6b 附录：N14=可选 24px 网格吸附（不启用 Vue Flow snapToGrid）；earliest 仍 N6；未改产品；digest 仍 `25c1df9c…`

### 迭代 P96（完成）
- [x] 无新 CV/busy 红测，未改产品；digest 仍 `25c1df9c…`；81 tests + typecheck:app PASS

### 迭代 P97（完成）
- [x] 6b 附录：N15=Arrow 微移 1px / Shift+Arrow 24px；earliest 仍 N6；未改产品；digest 仍 `25c1df9c…`

### 迭代 P98（完成）
- [x] 无新 CV/busy 红测，未改产品；digest 仍 `25c1df9c…`；81 tests + typecheck:app PASS

### 迭代 P99（完成）
- [x] 6b 附录：N16=⌘A 全选当前 nodes；earliest 仍 N6；未改产品；digest 仍 `25c1df9c…`

### 迭代 P100（完成）
- [x] 无新 CV/busy 红测，未改产品；digest 仍 `25c1df9c…`；81 tests + typecheck:app PASS

### 迭代 P101（完成）
- [x] 6b 附录：N17=Space+左键拖平移（不改默认框选）；earliest 仍 N6；未改产品；digest 仍 `25c1df9c…`

### 迭代 P102（完成）
- [x] 无新 CV/busy 红测，未改产品；digest 仍 `25c1df9c…`；81 tests + typecheck:app PASS

### 迭代 P103（完成）
- [x] 6b 附录：N18=Escape 关弹层后再清节点选区；earliest 仍 N6；未改产品；digest 仍 `25c1df9c…`

### 迭代 P104（完成）
- [x] 无新 CV/busy 红测，未改产品；digest 仍 `25c1df9c…`；81 tests + typecheck:app PASS

### 迭代 P105（完成）
- [x] 6b 附录：N19=Shift+⌘A 反选；earliest 仍 N6；未改产品；digest 仍 `25c1df9c…`

### 迭代 P106（完成）
- [x] 无新 CV/busy 红测，未改产品；digest 仍 `25c1df9c…`；81 tests + typecheck:app PASS

### 迭代 P107（完成）
- [x] 6b 附录：N20=Alt+Arrow 走 applyAlign；earliest 仍 N6；未改产品；digest 仍 `25c1df9c…`

### 迭代 P108（完成）
- [x] 无新 CV/busy 红测，未改产品；digest 仍 `25c1df9c…`；81 tests + typecheck:app PASS

### 迭代 P109（完成）
- [x] 6b 附录：N21=Alt+H/V 居中、Alt+Shift+H/V 均分；earliest 仍 N6；未改产品；digest 仍 `25c1df9c…`

### 迭代 P110（完成）
- [x] 无新 CV/busy 红测，未改产品；digest 仍 `25c1df9c…`；81 tests + typecheck:app PASS

### 迭代 P111（完成）
- [x] 6b 附录：N22=Shift+E 走 toggleEdges；earliest 仍 N6；未改产品；digest 仍 `25c1df9c…`

### 迭代 P112（完成）
- [x] 无新 CV/busy 红测，未改产品；digest 仍 `25c1df9c…`；81 tests + typecheck:app PASS

### 迭代 P113（完成）
- [x] 6b 附录：N23=Shift+M 走 toggleMiniMap；earliest 仍 N6；未改产品；digest 仍 `25c1df9c…`

### 迭代 P114（完成）
- [x] 无新 CV/busy 红测，未改产品；digest 仍 `25c1df9c…`；81 tests + typecheck:app PASS

### 迭代 P115（完成）
- [x] 6b 附录：N24=Shift+W 走 toggleWorkspaceMode；earliest 仍 N6；未改产品；digest 仍 `25c1df9c…`

### 迭代 P116（完成）
- [x] 无新 CV/busy 红测，未改产品；digest 仍 `25c1df9c…`；81 tests + typecheck:app PASS

### 迭代 P117（完成）
- [x] 6b 附录：N25=Shift+T 走 applyTimelineLayout；earliest 仍 N6；未改产品；digest 仍 `25c1df9c…`

### 迭代 P118（完成）
- [x] 无新 CV/busy 红测，未改产品；digest 仍 `25c1df9c…`；81 tests + typecheck:app PASS

### 迭代 P119（完成）
- [x] 6b 附录：N26=F5 走 refreshAll；earliest 仍 N6；未改产品；digest 仍 `25c1df9c…`

### 迭代 P120（完成）
- [x] 无新 CV/busy 红测，未改产品；digest 仍 `25c1df9c…`；81 tests + typecheck:app PASS

### 迭代 P121（完成）
- [x] 6b 附录：N27=C 走 toggleConnectMode；earliest 仍 N6；未改产品；digest 仍 `25c1df9c…`

### 迭代 P122（完成）
- [x] 无新 CV/busy 红测，未改产品；digest 仍 `25c1df9c…`；81 tests + typecheck:app PASS

### 迭代 P123（完成）
- [x] 6b 附录：N28=F1 走 toggleHelp；earliest 仍 N6；未改产品；digest 仍 `25c1df9c…`

### 迭代 P124（完成）
- [x] 无新 CV/busy 红测，未改产品；digest 仍 `25c1df9c…`；81 tests + typecheck:app PASS

### 迭代 P125（完成）
- [x] 6b 附录：N29=A 走 toggleAddMenu；earliest 仍 N6；未改产品；digest 仍 `25c1df9c…`

### 迭代 P126（完成）
- [x] 无新 CV/busy 红测，未改产品；digest 仍 `25c1df9c…`；81 tests + typecheck:app PASS

### 迭代 P127（完成）
- [x] 6b 附录：N30=L 走 toggleLibrary；earliest 仍 N6；未改产品；digest 仍 `25c1df9c…`

### 迭代 P128（完成）
- [x] 无新 CV/busy 红测，未改产品；digest 仍 `25c1df9c…`；81 tests + typecheck:app PASS

### 迭代 P129（完成）
- [x] 6b 附录：N31=Shift+L 走 toggleGlobalResourceLibrary；earliest 仍 N6；未改产品；digest 仍 `25c1df9c…`

### 迭代 P130（完成）
- [x] 无新 CV/busy 红测，未改产品；digest 仍 `25c1df9c…`；81 tests + typecheck:app PASS

### 迭代 P131（完成）
- [x] 6b 附录：N32=F6 走 verifyLocalProductionSource；earliest 仍 N6；未改产品；digest 仍 `25c1df9c…`

### 迭代 P132（完成）
- [x] 无新 CV/busy 红测，未改产品；digest 仍 `25c1df9c…`；83 tests + typecheck:app PASS

### 迭代 P133（完成）
- [x] 6b 附录：N33=Shift+D 走 setCanvasTheme 循环 light/dark/paper；earliest 仍 N6；未改产品；digest 仍 `25c1df9c…`

### 迭代 P134（完成）
- [x] 无新 CV/busy 红测，未改产品；digest 仍 `25c1df9c…`；83 tests + typecheck:app PASS

### 迭代 P135（完成）
- [x] 6b 附录：N34=⌘F 聚焦 timeline-progress-query；earliest 仍 N6；未改产品；digest 仍 `25c1df9c…`

### 迭代 P136（完成）
- [x] 无新 CV/busy 红测，未改产品；digest 仍 `25c1df9c…`；83 tests + typecheck:app PASS

### 迭代 P137（完成）
- [x] 6b 附录：N35=搜索框 Enter 走 focusTimelineSearchResult；earliest 仍 N6；未改产品；digest 仍 `25c1df9c…`

### 迭代 P138（完成）
- [x] 无新 CV/busy 红测，未改产品；digest 仍 `25c1df9c…`；83 tests + typecheck:app PASS

### 迭代 P139（完成）
- [x] 6b 附录：N36=F3/Shift+F3 循环搜索多命中；earliest 仍 N6；未改产品；digest 仍 `25c1df9c…`

### 迭代 P140（完成）
- [x] 无新 CV/busy 红测，未改产品；digest 仍 `25c1df9c…`；83 tests + typecheck:app PASS

### 迭代 P141（完成）
- [x] 6b 附录：N37=查询框非空 Escape 先清查询，不抢 N18；earliest 仍 N6；未改产品；digest 仍 `25c1df9c…`

### 迭代 P142（完成）
- [x] 无新 CV/busy 红测，未改产品；digest 仍 `25c1df9c…`；83 tests + typecheck:app PASS

### 迭代 P143（完成）
- [x] 6b 附录：N38=空查询 Escape 先 blur 查询框，再按才 N18；earliest 仍 N6；未改产品；digest 仍 `25c1df9c…`

### 迭代 P144（完成）
- [x] 无新 CV/busy 红测，未改产品；digest 仍 `25c1df9c…`；83 tests + typecheck:app PASS

### 迭代 P145（完成）
- [x] 6b 附录：N39=查询框 Alt+Arrow 循环 timelineProgressReview；earliest 仍 N6；未改产品；digest 仍 `25c1df9c…`

### 迭代 P146（完成）
- [x] 无新 CV/busy 红测，未改产品；digest 仍 `25c1df9c…`；83 tests + typecheck:app PASS

### 迭代 P147（完成）
- [x] 6b 附录：N40=筛选框 Escape 聚焦 timeline-progress-query；earliest 仍 N6；未改产品；digest 仍 `25c1df9c…`

### 迭代 P148（完成）
- [x] 无新 CV/busy 红测，未改产品；digest 仍 `25c1df9c…`；83 tests + typecheck:app PASS

### 迭代 P149（完成）
- [x] 6b 附录：N41=`[`/`]` 走 focusPanelOnCanvas 循环时间线条；earliest 仍 N6；未改产品；digest 仍 `25c1df9c…`

### 迭代 P150（完成）
- [x] 无新 CV/busy 红测，未改产品；digest 仍 `25c1df9c…`；83 tests + typecheck:app PASS

### 迭代 P151（完成）
- [x] 6b 附录：N42=Home/End 走 focusPanelOnCanvas 首末格；earliest 仍 N6；未改产品；digest 仍 `25c1df9c…`

### 迭代 P152（完成）
- [x] 无新 CV/busy 红测，未改产品；digest 仍 `25c1df9c…`；83 tests + typecheck:app PASS

### 迭代 P153（完成）
- [x] 6b 附录：N43=时间线条芯片 roving tabindex；earliest 仍 N6；未改产品；digest 仍 `25c1df9c…`

### 迭代 P154（完成）
- [x] 无新 CV/busy 红测，未改产品；digest 仍 `25c1df9c…`；83 tests + typecheck:app PASS

### 迭代 P155（完成）
- [x] 6b 附录：N44=芯片焦点 PageUp/PageDown 跳 10 格；earliest 仍 N6；未改产品；digest 仍 `25c1df9c…`

### 迭代 P156（完成）
- [x] 无新 CV/busy 红测，未改产品；digest 仍 `25c1df9c…`；83 tests + typecheck:app PASS

### 迭代 P157（完成）
- [x] 6b 附录：N45=无芯片焦点 PageUp/PageDown 走 focusPanelOnCanvas 跳 10 格；earliest 仍 N6；未改产品；digest 仍 `25c1df9c…`

### 迭代 P158（完成）
- [x] 无新 CV/busy 红测，未改产品；digest 仍 `25c1df9c…`；83 tests + typecheck:app PASS

### 迭代 P159（完成）
- [x] 6b 附录：N46=单元轨 library-item PageUp/PageDown 走 selectUnit 跳 10 条；earliest 仍 N6；未改产品；digest 仍 `25c1df9c…`

### 迭代 P160（完成）
- [x] 无新 CV/busy 红测，未改产品；digest 仍 `25c1df9c…`；83 tests + typecheck:app PASS

### 迭代 P161（完成）
- [x] 6b 附录：N47=单元轨 Alt+PageUp/PageDown 走 unitsPrevious/unitsNext；earliest 仍 N6；未改产品；digest 仍 `25c1df9c…`

### 迭代 P162（完成）
- [x] 无新 CV/busy 红测，未改产品；digest 仍 `25c1df9c…`；83 tests + typecheck:app PASS

### 迭代 P163（完成）
- [x] 6b 附录：N48=单元轨 library-item Arrow roving tabindex；earliest 仍 N6；未改产品；digest 仍 `25c1df9c…`

### 迭代 P164（完成）
- [x] 无新 CV/busy 红测，未改产品；digest 仍 `25c1df9c…`；83 tests + typecheck:app PASS

### 迭代 P165（完成）
- [x] 6b 附录：N49=素材库可见行 Arrow roving tabindex；earliest 仍 N6；未改产品；digest 仍 `25c1df9c…`

### 迭代 P166（完成）
- [x] 无新 CV/busy 红测，未改产品；digest 仍 `25c1df9c…`；83 tests + typecheck:app PASS

### 迭代 P167（完成）
- [x] 6b 附录：N50=剧本/提示词 text-list Arrow roving tabindex；earliest 仍 N6；未改产品；digest 仍 `25c1df9c…`

### 迭代 P168（完成）
- [x] 无新 CV/busy 红测，未改产品；digest 仍 `25c1df9c…`；83 tests + typecheck:app PASS

### 迭代 P169（完成）
- [x] 6b 附录：N51=媒体库 media-library-item Arrow roving tabindex；earliest 仍 N6；未改产品；digest 仍 `25c1df9c…`

### 迭代 P170（完成）
- [x] 无新 CV/busy 红测，未改产品；digest 仍 `25c1df9c…`；83 tests + typecheck:app PASS

### 迭代 P171（完成）
- [x] 6b 附录：N52=媒体库 Alt+PageUp/PageDown 走 mediaPrevious/mediaNext；earliest 仍 N6；未改产品；digest 仍 `25c1df9c…`

### 迭代 P172（完成）
- [x] 无新 CV/busy 红测，未改产品；digest 仍 `25c1df9c…`；83 tests + typecheck:app PASS

### 迭代 P173（完成）
- [x] 6b 附录：N53=素材库 Alt+PageUp/PageDown 走 assetsPrevious/assetsNext；earliest 仍 N6；未改产品；digest 仍 `25c1df9c…`

### 迭代 P174（完成）
- [x] 无新 CV/busy 红测，未改产品；digest 仍 `25c1df9c…`；83 tests + typecheck:app PASS

### 迭代 P175（完成）
- [x] 6b 附录：N54=全局资源 Alt+PageUp/PageDown 走 globalResourcesPrevious/globalResourcesNext；earliest 仍 N6；未改产品；digest 仍 `25c1df9c…`

### 迭代 P176（完成）
- [x] 无新 CV/busy 红测，未改产品；digest 仍 `25c1df9c…`；83 tests + typecheck:app PASS

### 迭代 P177（完成）
- [x] 6b 附录：N55=检查器出场时间线 Alt+PageUp/PageDown 走 appearancesPrevious/appearancesNext；earliest 仍 N6；未改产品；digest 仍 `25c1df9c…`

### 迭代 P178（完成）
- [x] 无新 CV/busy 红测，未改产品；digest 仍 `25c1df9c…`；83 tests + typecheck:app PASS

### 迭代 P179（完成）
- [x] 6b 附录：N56=检查器出场行 appearance-list button Arrow roving tabindex；earliest 仍 N6；未改产品；digest 仍 `25c1df9c…`

### 迭代 P180（完成）
- [x] 无新 CV/busy 红测，未改产品；digest 仍 `25c1df9c…`；83 tests + typecheck:app PASS

### 迭代 P181（完成）
- [x] 6b 附录：N57=全局资源卡 global-resource-card Arrow roving tabindex；earliest 仍 N6；未改产品；digest 仍 `25c1df9c…`

### 迭代 P182（完成）
- [x] 无新 CV/busy 红测，未改产品；digest 仍 `25c1df9c…`；83 tests + typecheck:app PASS

### 迭代 P183（完成）
- [x] 6b 附录：N58=节点操作钮 node-action-buttons Arrow roving tabindex；earliest 仍 N6；未改产品；digest 仍 `25c1df9c…`

### 迭代 P184（完成）
- [x] 无新 CV/busy 红测，未改产品；digest 仍 `25c1df9c…`；83 tests + typecheck:app PASS

### 迭代 P185（完成）
- [x] 6b 附录：N59=当前素材库 library-tabs Arrow roving tabindex；earliest 仍 N6；未改产品；digest 仍 `25c1df9c…`

### 迭代 P186（完成）
- [x] 无新 CV/busy 红测，未改产品；digest 仍 `25c1df9c…`；83 tests + typecheck:app PASS

### 迭代 P187（完成）
- [x] 6b 附录：N60=全局资源 tabs global-resource-tabs Arrow roving tabindex；earliest 仍 N6；未改产品；digest 仍 `25c1df9c…`

### 迭代 P188（完成）
- [x] 无新 CV/busy 红测，未改产品；digest 仍 `25c1df9c…`；83 tests + typecheck:app PASS

### 迭代 P189（完成）
- [x] 6b 附录：N61=添加菜单 add-menu button Arrow roving tabindex；earliest 仍 N6；未改产品；digest 仍 `25c1df9c…`

### 迭代 P190（完成）
- [x] 无新 CV/busy 红测，未改产品；digest 仍 `25c1df9c…`；83 tests + typecheck:app PASS

### 迭代 P191（完成）
- [x] 6b 附录：N62=浮动工具栏 floating-tools 顶层钮 Arrow roving tabindex；earliest 仍 N6；未改产品；digest 仍 `25c1df9c…`

### 迭代 P192（完成）
- [x] 无新 CV/busy 红测，未改产品；digest 仍 `25c1df9c…`；83 tests + typecheck:app PASS

### 迭代 P193（完成）
- [x] 6b 附录：N63=底部视图工具 bottom-tools 可用钮 Arrow roving tabindex；earliest 仍 N6；未改产品；digest 仍 `25c1df9c…`

### 迭代 P194（完成）
- [x] 无新 CV/busy 红测，未改产品；digest 仍 `25c1df9c…`；83 tests + typecheck:app PASS

### 迭代 P195（完成）
- [x] 6b 附录：N64=视图菜单 view-menu-pop > button Arrow roving tabindex；earliest 仍 N6；未改产品；digest 仍 `25c1df9c…`

### 迭代 P196（完成）
- [x] 无新 CV/busy 红测，未改产品；digest 仍 `25c1df9c…`；83 tests + typecheck:app PASS

### 迭代 P197（完成）
- [x] 6b 附录：N65=视图菜单主题 view-menu-theme radio Arrow roving tabindex；earliest 仍 N6；未改产品；digest 仍 `25c1df9c…`

### 迭代 P198（完成）
- [x] 无新 CV/busy 红测，未改产品；digest 仍 `25c1df9c…`；83 tests + typecheck:app PASS

### 迭代 P199（完成）
- [x] 6b 附录：N66=受管画布 Vue Flow Controls-button Arrow roving tabindex；earliest 仍 N6；未改产品；digest 仍 `25c1df9c…`

### 迭代 P200（完成）
- [x] 无新 CV/busy 红测，未改产品；digest 仍 `25c1df9c…`；83 tests + typecheck:app PASS

### 迭代 P201（完成）
- [x] 6b 附录：N67=故事事件图 story-graph-connect Controls-button Arrow roving tabindex；earliest 仍 N6；未改产品；digest 仍 `25c1df9c…`

### 迭代 P202（完成）
- [x] 无新 CV/busy 红测，未改产品；digest 仍 `25c1df9c…`；83 tests + typecheck:app PASS

### 迭代 P203（完成）
- [x] 6b 附录：N68=遗留生产画布 production-flow Controls-button Arrow roving tabindex；earliest 仍 N6；未改产品；digest 仍 `25c1df9c…`

### 迭代 P204（完成）
- [x] 无新 CV/busy 红测，未改产品；digest 仍 `25c1df9c…`；83 tests + typecheck:app PASS

### 迭代 P205（完成）
- [x] 6b 附录：N69=受管 MiniMap managed-canvas-minimap 焦点 Arrow 平移视口；earliest 仍 N6；未改产品；digest 仍 `25c1df9c…`

### 迭代 P206（完成）
- [x] 无新 CV/busy 红测，未改产品；digest 仍 `25c1df9c…`；83 tests + typecheck:app PASS

### 迭代 P207（完成）
- [x] 6b 附录：N70=帮助卡 managed-canvas-help-card dialog 初焦关闭钮 + Tab 环；earliest 仍 N6；未改产品；digest 仍 `25c1df9c…`

### 迭代 P208（完成）
- [x] 无新 CV/busy 红测，未改产品；digest 仍 `25c1df9c…`；83 tests + typecheck:app PASS

### 迭代 P209（完成）
- [x] 6b 附录：N71=MiniMap 节点 data-node-id roving + Enter 选中（禁止 HTML id）；earliest 仍 N6；未改产品；digest 仍 `25c1df9c…`

### 迭代 P210（完成）
- [x] 无新 CV/busy 红测，未改产品；digest 仍 `25c1df9c…`；83 tests + typecheck:app PASS

### 迭代 P211（完成）
- [x] 6b 附录：N72=连线横幅 connect-banner 退出钮 testid + 焦点归还连线钮；earliest 仍 N6；未改产品；digest 仍 `25c1df9c…`

### 迭代 P212（完成）
- [x] 无新 CV/busy 红测，未改产品；digest 仍 `25c1df9c…`；83 tests + typecheck:app PASS

### 迭代 P213（完成）
- [x] 6b 附录：N73=检查器 inspector-close testid + 关闭后焦点归还画布（aside 不改 dialog）；earliest 仍 N6；未改产品；digest 仍 `25c1df9c…`

### 迭代 P214（完成）
- [x] 无新 CV/busy 红测，未改产品；digest 仍 `25c1df9c…`；83 tests + typecheck:app PASS

### 迭代 P215（完成）
- [x] 6b 附录：N74=导演动作面板 dialog 初焦过滤框 + Tab 环 + 关闭后归还导演钮；earliest 仍 N6；未改产品；digest 仍 `25c1df9c…`

### 迭代 P216（完成）
- [x] 无新 CV/busy 红测，未改产品；digest 仍 `25c1df9c…`；83 tests + typecheck:app PASS

### 迭代 P217（完成）
- [x] 6b 附录：N75=素材库/剧本资源关闭钮 testid + 关闭后焦点归还对应开库钮（aside 不改 dialog）；earliest 仍 N6；未改产品；digest 仍 `25c1df9c…`

### 迭代 P218（完成）
- [x] 无新 CV/busy 红测，未改产品；digest 仍 `25c1df9c…`；83 tests + typecheck:app PASS

### 迭代 P219（完成）
- [x] 6b 附录：N76=错误横幅 canvas-error 关闭钮 testid + 关闭后焦点归还画布（alert 不改 dialog）；earliest 仍 N6；未改产品；digest 仍 `25c1df9c…`

### 迭代 P220（完成）
- [x] 无新 CV/busy 红测，未改产品；digest 仍 `25c1df9c…`；83 tests + typecheck:app PASS

### 迭代 P221（完成）
- [x] 6b 附录：N77=清空画布二次确认后焦点归还画布（不改 window.confirm；Escape 仍只解除武装）；earliest 仍 N6；未改产品；digest 仍 `25c1df9c…`

### 迭代 P222（完成）
- [x] 无新 CV/busy 红测，未改产品；digest 仍 `25c1df9c…`；83 tests + typecheck:app PASS

### 迭代 P223（完成）
- [x] 6b 附录：N78=帮助卡关闭钮 testid + 点击关闭后焦点归还帮助触发钮（不抢 N70 初焦/Tab；Escape 仍 N18）；earliest 仍 N6；未改产品；digest 仍 `25c1df9c…`

### 迭代 P224（完成）
- [x] 无新 CV/busy 红测，未改产品；digest 仍 `25c1df9c…`；83 tests + typecheck:app PASS

### 迭代 P225（完成）
- [x] 6b 附录：N79=视图菜单关闭后焦点归还 summary（打开初焦仍 N64；Escape 仍 N18；帮助/添加归还优先）；earliest 仍 N6；未改产品；digest 仍 `25c1df9c…`

### 迭代 P226（完成）
- [x] 无新 CV/busy 红测，未改产品；digest 仍 `25c1df9c…`；83 tests + typecheck:app PASS

### 迭代 P227（完成）
- [x] 6b 附录：N80=画布诊断 details summary testid（原生 disclosure；Escape 不关；不抢检查器诊断）；earliest 仍 N6；未改产品；digest 仍 `25c1df9c…`

### 迭代 P228（完成）
- [x] 无新 CV/busy 红测，未改产品；digest 仍 `25c1df9c…`；83 tests + typecheck:app PASS

### 迭代 P229（完成）
- [x] 6b 附录：N81=检查器诊断 details summary testid（原生 disclosure；Escape 不关；不抢 N73/N80）；earliest 仍 N6；未改产品；digest 仍 `25c1df9c…`

### 迭代 P230（完成）
- [x] 无新 CV/busy 红测，未改产品；digest 仍 `25c1df9c…`；83 tests + typecheck:app PASS

### 迭代 P231（完成）
- [x] 6b 附录：N82=素材库详情栏诊断 details summary testid（原生 disclosure；不铺列表行；不抢 N80/N81）；earliest 仍 N6；未改产品；digest 仍 `25c1df9c…`

### 迭代 P232（完成）
- [x] 无新 CV/busy 红测，未改产品；digest 仍 `25c1df9c…`；77 tests + typecheck:app PASS

### 迭代 P233（完成）
- [x] 6b 附录：N83=审片下一动作诊断 details summary testid（原生 disclosure；Escape 不关；不铺资产/冲突行；不抢 N80–N82）；earliest 仍 N6；未改产品；digest 仍 `25c1df9c…`

### 迭代 P234（完成）
- [x] 无新 CV/busy 红测，未改产品；digest 仍 `25c1df9c…`；77 tests + typecheck:app PASS

### 迭代 P235（完成）
- [x] 6b 附录：N84=生成控制技术消息诊断 details summary testid（原生 disclosure；不改 pack-identity；不抢 N80–N83）；earliest 仍 N6；未改产品；digest 仍 `25c1df9c…`

### 迭代 P236（完成）
- [x] 无新 CV/busy 红测，未改产品；digest 仍 `25c1df9c…`；77 tests + typecheck:app PASS

### 迭代 P237（完成）
- [x] 6b 附录：N85=审片 Review 头栏诊断 details summary testid（原生 disclosure；Escape 不关；不铺资产/冲突/批次行；不抢 N80–N84）；earliest 仍 N6；未改产品；digest 仍 `25c1df9c…`

### 迭代 P238（完成）
- [x] 无新 CV/busy 红测，未改产品；digest 仍 `25c1df9c…`；77 tests + typecheck:app PASS

### 迭代 P239（完成）
- [x] 6b 附录：N86=审片资产卡诊断 details summary testid（原生 disclosure；共享 testid；不铺冲突/批次行；不抢 N80–N85）；earliest 仍 N6；未改产品；digest 仍 `25c1df9c…`

### 迭代 P240（完成）
- [x] 无新 CV/busy 红测，未改产品；digest 仍 `25c1df9c…`；77 tests + typecheck:app PASS

### 迭代 P241（完成）
- [x] 6b 附录：N87=审片冲突卡诊断 details summary testid（原生 disclosure；共享 testid；不铺批次行；不抢 N80–N86）；earliest 仍 N6；未改产品；digest 仍 `25c1df9c…`

### 迭代 P242（完成）
- [x] 无新 CV/busy 红测，未改产品；digest 仍 `25c1df9c…`；77 tests + typecheck:app PASS

### 迭代 P243（完成）
- [x] 6b 附录：N88=审片批次卡诊断 details summary testid（原生 disclosure；共享 testid；不给 blocking-batch 新加 details；不抢 N80–N87）；earliest 仍 N6；未改产品；digest 仍 `25c1df9c…`

### 迭代 P244（完成）
- [x] 无新 CV/busy 红测，未改产品；digest 仍 `25c1df9c…`；77 tests + typecheck:app PASS

### 迭代 P245（完成）
- [x] 6b 附录：N89=素材库关联行诊断 details summary testid（原生 disclosure；共享 testid；不铺版本行；不抢 N82/N80–N88）；earliest 仍 N6；未改产品；digest 仍 `25c1df9c…`

### 迭代 P246（完成）
- [x] 无新 CV/busy 红测，未改产品；digest 仍 `25c1df9c…`；77 tests + typecheck:app PASS

### 迭代 P247（完成）
- [x] 6b 附录：N90=素材库版本行诊断 details summary testid（原生 disclosure；共享 testid；不抢 N82/N89）；earliest 仍 N6；未改产品；digest 仍 `25c1df9c…`

### 迭代 P248（完成）
- [x] 无新 CV/busy 红测，未改产品；digest 仍 `25c1df9c…`；77 tests + typecheck:app PASS

### 迭代 P249（完成）
- [x] 6b 附录：N91=审片空态诊断 details summary testid（原生 disclosure；不改查询表单；生成计划 ID 诊断另刀；不抢 N80–N90）；earliest 仍 N6；未改产品；digest 仍 `25c1df9c…`

### 迭代 P250（完成）
- [x] 无新 CV/busy 红测，未改产品；digest 仍 `25c1df9c…`；77 tests + typecheck:app PASS

### 迭代 P251（完成）
- [x] 6b 附录：N92=生成控制计划 ID 诊断 details summary testid（原生 disclosure；共享 testid；不抢 N84/pack-identity；绑定工作台另刀）；earliest 仍 N6；未改产品；digest 仍 `25c1df9c…`

### 迭代 P252（完成）
- [x] 无新 CV/busy 红测，未改产品；digest 仍 `25c1df9c…`；77 tests + typecheck:app PASS

### 迭代 P253（完成）
- [x] 6b 附录：N93=绑定工作台 `.binding-diagnostics` summary testid（原生 disclosure；共享 testid；不改空镜说明/冻结钮；驾驶舱诊断另刀；不抢 N80–N92）；earliest 仍 N6；未改产品；digest 仍 `25c1df9c…`

### 迭代 P254（完成）
- [x] N7 检查器角色音频原生试听 + mutex/busy；5 files / 87 tests + typecheck:app PASS；digest `9cf8a12c…`→后续已漂

### 迭代 P255（完成）
- [x] N8 入库 aliases → create_studio_asset；检查器/库行展示；89 tests + typecheck:app PASS

### 迭代 P256（完成）
- [x] N9–N11 Shift+1/0/2 视口快捷键 + Controls 覆盖默认 fitView；90 tests + typecheck:app PASS；digest `3e49d01b…`

### 迭代 P257（完成）
- [x] N12 入库可选 description，空则保留模板句；92 tests + typecheck:app PASS

### 迭代 P258（完成）
- [x] N13 Delete/Backspace 优先删所选连线否则卸钉；`:delete-key-code="() => false"`；digest `132ba3f4…`

### 迭代 P259（完成）
- [x] N14 可选 24px 网格吸附默认关；对象吸附后 round；成组拖不 round

### 迭代 P260（完成）
- [x] N15 Arrow 1px / Shift+Arrow 24px，无选区不 mutate

### 迭代 P261（完成）
- [x] N16 ⌘A 全选当前 nodes；空图不 mutate；digest `16f62c06…`；91 tests + typecheck:app PASS

### 迭代 P262（完成）
- [x] N17 Space pan-on-drag 含 0，keyup 回 `[1,2]`；默认左键仍框选

### 迭代 P263（完成）
- [x] N18 Escape 关弹层后清选区；拖拽中不清选

### 迭代 P264（完成）
- [x] N19 Shift+⌘A 反选；digest `2b0608d7…`；94 tests + typecheck:app PASS

### 迭代 P265（完成）
- [x] N20 Alt+Arrow 走 applyAlign；N15 仍 `!altKey`

### 迭代 P266（完成）
- [x] N21 Alt+H/V 居中、Alt+Shift+H/V 均分；digest `66091716…`；96 tests + typecheck:app PASS

### 迭代 P267（完成）
- [x] N22–N26 Shift+E/M/W/T 与 F5 视图快捷键；不抢导演和弦；digest `842abfe0…`；98 tests + typecheck:app PASS

### 迭代 P268（完成）
- [x] N27–N31 C/F1/A/L/Shift+L 工具面板快捷键；digest `9b3b8b29…`；99 tests + typecheck:app PASS

### 迭代 P269（完成）
- [x] N32–N35 F6 核对、Shift+D 主题、⌘F 聚焦、Enter 唯一命中；digest `6dad03c6…`；100 tests + typecheck:app PASS

### 迭代 P270（完成）
- [x] N36–N38 F3 循环命中、Escape 先清查询再失焦；digest `ddeb1db7…`；101 tests + typecheck:app PASS

### 迭代 P271（完成）
- [x] N39–N41 审片筛选循环、Escape 回焦、宫格 `[`/`]`；digest `a29e41c7…`；102 tests + typecheck:app PASS

### 迭代 P272（完成）
- [x] N42–N44 Home/End 定位首末、条内 roving、芯片 Page 跳 10；digest `6bc21332…`；102 tests + typecheck:app PASS

### 迭代 P273（完成）
- [x] N45–N47 画布 Page 跳格、单元轨 Page、Alt+Page 翻页；digest `dce94757…`；102 tests + typecheck:app PASS

### 迭代 P274（完成）
- [x] N48–N50 单元轨/素材窗/文稿列表 roving tabindex；digest `a1463e4b…`；103 tests + typecheck:app PASS

### 迭代 P275（完成）
- [x] N51–N53 媒体行 roving、媒体/素材 Alt+Page 翻页；digest `18dbc1e7…`；104 tests + typecheck:app PASS

### 迭代 P276–P277（完成）
- [x] N54 全局资源 Alt+Page 翻页；N55 出场 Alt+Page 翻页；digest `9d36b0c7…`；99 tests + typecheck:app PASS

### 迭代 P278–P280（完成）
- [x] N56 出场行 roving、N57 全局卡 roving、N58 操作钮 roving（跳过 disabled）；digest `0ff21755…`；102 tests + typecheck:app PASS

### 迭代 P281–P284（完成）
- [x] N59 素材库 tabs roving、N60 全局资源 tabs roving、N61 添加菜单 roving、N62 浮动工具栏 roving；digest `c184b2a3…`；106 tests + typecheck:app PASS

### 迭代 P285–P287（完成）
- [x] N63 底栏 roving、N64 视图菜单项 roving、N65 主题 radio roving；digest `d56c6935…`；109 tests + typecheck:app PASS

### 迭代 P288–P290（完成）
- [x] N66 受管 Controls roving、N67 故事图 Controls roving、N68 遗留 Controls roving；digest `ee047112…`；129 tests + typecheck:app PASS

### 迭代 P291–P292（完成）
- [x] N69 MiniMap Arrow 平移、N70 帮助卡焦点陷阱；digest `75048002…`；112 tests + typecheck:app PASS

### 迭代 P293–P294（完成）
- [x] N71 MiniMap 节点键盘选中、N72 连线横幅退出焦点；digest `e7398624…`；114 tests + typecheck:app PASS

### 迭代 P295–P297（完成）
- [x] N73 检查器关闭、N74 导演面板焦点、N75 侧栏关闭；digest `bd8778d6…`；117 tests + typecheck:app PASS

### 迭代 P298–P300（完成）
- [x] N76 错误横幅关闭、N77 清空确认焦点、N78 帮助关闭 testid；digest `b4fff273…`；120 tests + typecheck:app PASS

### 迭代 P301–P303（完成）
- [x] N79 视图菜单归焦、N80 画布诊断、N81 检查器诊断；digest `35e3a828…`；123 tests + typecheck:app PASS

### 迭代 P304–P306（完成）
- [x] N82 素材库详情诊断、N83 审片下一动作诊断、N84 生成控制消息诊断；digest `fc19fd69…`；113 tests + typecheck:app PASS

### 迭代 P307–P309（完成）
- [x] N85 审片头栏诊断、N86 资产卡诊断、N87 冲突卡诊断；digest `bd3cf57c…`；116 tests + typecheck:app PASS

### 迭代 P310–P312（完成）
- [x] N88 审片批次卡诊断、N89 素材库关联行诊断、N90 版本行诊断；digest `2ad9c41b…`；121 tests + typecheck:app PASS

### 迭代 P313–P315（完成）
- [x] N91 审片空态诊断、N92 生成控制计划 ID 诊断、N93 绑定诊断；digest `2d8673b5…`；121 tests + typecheck:app PASS

### 迭代 P316–P318（完成）
- [x] N94 驾驶舱头栏下一动作诊断、N95 单元遗留诊断、N96 控制资产诊断；digest `7a610d0b…`；124 tests + typecheck:app PASS

### 迭代 P319–P321（完成）
- [x] N97 页脚状态指纹诊断、N98 准备清单诊断、N99 生成前预览诊断；digest `4611c913…`；127 tests + typecheck:app PASS

### 迭代 P322–P324（完成）
- [x] N100 驾驶舱绑定指纹诊断、N101 素材库权威图诊断、N102 桌面支持诊断；digest `3575b959…`；133 tests + typecheck:app PASS

### 迭代 P325–P327（完成）
- [x] N103 详细诊断、N104 项目概览、N105 高级操作 summary testid；digest `fb161a3f…`；118 tests + typecheck:app PASS

### 迭代 P328–P330（完成）
- [x] N106 冻结包身份、N107 结果行身份、N108 审片提交身份 summary testid；digest `0e38b378…`；35 tests + typecheck:app PASS

### 迭代 P331–P333（完成）
- [x] N109 剧本原文、N110 关系编辑器、N111 Context Pack 回执 summary testid；digest `2925d643…`；52 tests + typecheck:app PASS

### 迭代 P334–P336（完成）
- [x] N112 逐项轨迹、N113 只读证据、N114 导演设计 summary testid；digest `d3918c28…`；59 tests + typecheck:app PASS

### 迭代 P337–P339（完成）
- [x] N115 对白、N116 连续性、N117 生成提示词 summary testid；digest `5bc8472b…`；62 tests + typecheck:app PASS

### 迭代 P340–P342（完成）
- [x] N118 审片 `.asset-control` 160px CV、N119 交接格 `.handoff-grid>div` 40px CV、N120 生产设计 `.registry-list article` 56px CV；digest `d32ef777…`；5 files / 42 tests + typecheck:app PASS

### 迭代 P343–P345（完成）
- [x] N121 成板历史卡 117px CV、N122 宫格条 190px CV、N123 成板门禁行 18px CV；digest `4b5df160…`；5 files / 45 tests + typecheck:app PASS

### 迭代 P346（下一步）
- [ ] N124 生产设计一致性成员卡 `.consistency-members article` content-visibility（产品切片，禁止附录-only；不抢 N115–N123；不改 saving）

### 后续候选
- [ ] 无窗口交互合同扫按钮 disabled/busy（已覆盖的不再铺）
- [ ] 仅当有测量证据才动 Core 读路径；禁止改 T23 `unitTimingQueries === returnedUnitCount` 合同
- [ ] 禁止 Electron 可见窗口、安装版 App、medium/P5/三模型全链重跑

### 边界
禁止 Git 写、安装、正式工程、付费生成、弹窗。

## software_goal: 24h-continuous-iteration-20260821

- status: `in_progress`
- deadline: `2026-08-22T09:40:00+08:00`
- live_identity: `9b532fc6b4a95bf3b84a7d593d12bb2d517a0f373df59e462f619d7fd1afd6ae`
- iteration_log: `.workqueue/continuous-iteration-20260821.md`

### 迭代 1（完成）
- [x] I1-A 定向 vitest：video-editor / multimedia-timeline / novel-studio 29 tests PASS
- [x] I1-B `novel_chat.py --selftest` PASS；urlopen 元组仍 TypeError
- [x] I1-C 同型扫描：撤销/快捷键、ShotTimeline、GenerationQueue.cancel、TaskCenter
- [x] I1-D 反思已写入 journal

### 迭代 2–4（完成）
- [x] I2 VideoEditor `editorWriteBusy` 挡住撤销/分割/Ripple/快捷键；12/12 PASS
- [x] I3 ShotTimeline `writeBusy` + load/selectUnit/move；2/2 PASS（未抢改 ScriptWorkbench）
- [x] I4 GenerationQueue cancel/saveSettings/enqueue 互斥；3/3 PASS

### 迭代 5（完成）
- [x] TaskCenter `create`/`claim`/`refresh` fail-closed；`loadCenter` 避免写入中 refresh 空转；2/2 PASS

### 迭代 6（完成）
- [x] 只读：`reviewCandidate` 已被并行会话修好（`if (busy.value) return` 在 prompt 前），队列测试 5/5 PASS，未双修该文件
- [x] 证实 `InspectorPanel.saveStatus`/`setAuthority` 缺 handler 重入 → 红测后修复；2/2 PASS
- [x] busy 合同回归 9 files / 46 tests PASS；`typecheck:app` PASS

### 迭代 7（完成）
- [x] 身份漂移核对：`4ac08316…` / 1075 files；I6 的 `5a2e973d` 降为历史
- [x] 回归 17 files / 64 tests PASS；两套 typecheck PASS；partition audit 408=276/91/36/5 PASS；适配器 selftest PASS
- [x] 无新红测，未改产品代码（并行会话已覆盖连续/导入/设置/接续/故事工作台 busy）

### 迭代 8（完成）
- [x] 身份：`afdbfcc3` 后本轮落到 `f99fa921…` / 1076 files
- [x] 并行会话已绿：legacy 撤销 busy、script-media-align、story-workbench；本轮不抢这些切片
- [x] 新红测：`saveCanvasEntity` 缺重入 + 保存中可 ⌘Z；红绿修复；legacy-canvas-history-busy 3/3 PASS；`typecheck:app` PASS

### 迭代 9（完成）
- [x] `removeCanvasEntity` / `chooseLinkEndpoint` / `onEdgeClick` 在 confirm 与首个 await 前抢 `canvasHistoryBusy`；4/4 PASS；`typecheck:app` PASS
- [x] 未碰并行会话正在改的 NovelStudio / NarrativeAdaptation

### 迭代 10（完成）
- [x] 身份：`e9f0aa9b…` / 1080 files；I9 `1c26e3e8` 降为历史
- [x] 并行会话已绿拖拽三合同；本轮回归 10/10，未双修 App.vue
- [x] `typecheck:app` PASS；partition 413=281/91/36/5 PASS；适配器 selftest PASS

### 迭代 11（完成）
- [x] 身份：`9b532fc6…` / 1081 files；I10 `e9f0aa9b` 降为历史
- [x] 并行会话已绿 `cancelScanNow` 失败可见；本轮回归 12/12，未双修 App.vue
- [x] `typecheck:app` PASS；partition 414=282/91/36/5 PASS；适配器 selftest PASS

### 迭代 12（下一步）
- [ ] 不要铺新页面。无新红测不改产品代码。等到 `2026-08-22T09:40+08:00` 或新复现 P0–P2

### 后续候选（按反思进入，不预支）
- [ ] 源码已漂：不得沿用 `bba45c71` 的 medium/P5/T23/三模型结论；只有本轮 digest 上的新门才算数
- [ ] 适配器绿后：对**当时冻结包**补 GLM 5.2 / 豆包各一次；身份不可验则 `IDENTITY_NOT_VERIFIED`
- [ ] 只在新红测时改产品代码；改完从两套 typecheck 起算

### 边界
禁止 Git 写、安装、正式工程、付费生成、destructive clean、覆盖旧 evidence。

## software_goal: multi-agent-hardening-handoff-20260814（2026-08-14 23:35 当前状态）

- status: `partially_completed_external_review_blocked`
- current_identity: `bba45c715c035b7c24e09796ec01e9208a7a5ffb77541f001f4b8f8f032c50ef` / buildId `90941534f2a5d3eb617fadd5386f2c0b` / 220 tools
- completed:
  - [x] medium 91/788、integration 36/127、heavy 5/18 从头完整通过；audit 0、build 与 digest/manifest 等式 PASS
  - [x] MCP smoke、P5 formal、P17、T23 build strict interactions、isolated Electron、isolated package 均按同一身份通过
  - [x] 生成脱敏冻结审查包；Kimi K3 实调 `PASS/findings=[]`，但身份不可可信验证，已标 `IDENTITY_NOT_VERIFIED`
  - [x] GLM 5.2 两次与豆包一次均实调并如实记录为本机适配器 `BLOCKED`；没有伪造模型正文或身份
  - [x] 新证据、验证报告与交接已更新；未改产品源码、未清理共享脏树
- blocked:
  - [ ] GLM 5.2 与豆包有效审查正文：当前 `novel_chat.py` 在 Python 3.14 `urllib` timeout tuple 路径崩溃，尚未到达 provider。需要用户授权的外部适配器修复切片；源码不变时不得重跑已绿本地门。
- evidence:
  - `docs/evidence/multi-model-review-pack-20260814-bba45c71.json`
  - `docs/evidence/multi-model-hardening-closeout-20260814-bba45c71.json`
  - `docs/验证报告_20260814_多代理强健化本地门与外部审查状态_bba45c71.md`

## software_goal: multi-agent-hardening-handoff-20260814

- status: `in_progress_handed_off`（产品实现和定向终审完成；最终分区/build/UI/模型链未完成）
- current_identity: `bba45c715c035b7c24e09796ec01e9208a7a5ffb77541f001f4b8f8f032c50ef` / 1062 files / 21,414,566 bytes；`release-manifest.json=624a0362…` 已过期，尚未 build
- completed:
  - [x] 多代理分方向实测、红绿修复与交叉只读审查
  - [x] 25 类 locator 全部 strict-readonly；`commit_agent_imagegen_result_bundle` 已入册，registry 25/25
  - [x] checkpoint schema 3：v1 NULL / v2 历史锚保留 / v3 新写非空；原子迁移、换 inode fail-close、真实 SIGKILL + Head-advance 恢复；定向 PASS + 独立 CLEAN
  - [x] bundle canonical token hash、legacy request-only key、storageKey 定点 proof、safe pre-terminal checkpoint、direct reconcile full、真实 child SIGKILL；18/18 + v5/legacy + registry PASS，独立 CLEAN
  - [x] P5 正式源只读 sentinel + 完整隔离副本 + Electron 有界关闭 + owned evidence 原子落盘；契约 7 tests PASS，独立 CLEAN
  - [x] T23 独立 startup preflight、v1/v2 健康快路、最终三次 CAS、list strict effect 分类、首卡 mutation 取证、原子 watcher lifecycle、失败指标脱敏；定向 PASS + 独立 CLEAN
  - [x] SQLite optional sidecar 消失/可变 WAL 波动不再假 409；悬空 symlink/目录/替换主库仍 fail-close；真实 DatabaseSync WAL 竞态测试 + 独立 CLEAN
  - [x] ABI 新增两通道明确入冻结集：272 handles / 259 invokes，数量、名称、集合摘要全锁；2/2 PASS
  - [x] `npm run typecheck` PASS
  - [x] `npm run typecheck:app` PASS
  - [x] partition audit PASS：395=263/91/36/5，fingerprint `fa59c19b0291953e928ac4dba72172ff5cf94c08497faa2d07dd22d06ad5a4ce`
  - [x] fast PASS：263/263 files，1524/1524 tests，566.96s
- pending_for_next_ai:
  - [ ] 从头跑完 medium 91 files；当前只有前 6/10 批 60 files / 581 tests 绿，第 7 批因用户交接指令中断（exit 130），整分区不计 PASS
  - [ ] 串行 `test:integration` 和 `test:heavy`
  - [ ] 运行 `audit:production`；然后唯一 `build`，复算 manifest/live digest 等式
  - [ ] 在新 build 上跑 MCP smoke、P5 formal、P17、T23 build strict interactions、isolated Electron、isolated package
  - [ ] 生成同一最终 digest 的脱敏 review pack，实调 Kimi K3、GLM 5.2、豆包；无法验证 returned identity 时标 `IDENTITY_NOT_VERIFIED`
  - [ ] 只在方案/真实门发现可复现 P0–P2 时做有界修复；任一源码变动后从两套 typecheck 重启全链
  - [ ] 更新新 evidence/验证报告/STATUS/TASKS/交接；逐项保留未跟踪 owner，不清理 `.analysis-src.tgz`
- git_state: HEAD `3c56e1d`；交接前 79 tracked modified / 37 untracked，tracked diff 约 `+11952/-802`；`git diff --check` PASS
- stale_evidence: `*696b0970*`、`624a0362…`、`d2e70bf9…`、`13d85a9f…` 只属历史，不计当前结果
- earliest_next: 接手 AI 按 `docs/当前开发交接.md` 21:59 CST 区块冷启动；无新红测不改代码，直接从头跑 medium
- boundaries: 禁止 reset/clean/checkout/stage/commit/push；不安装、不发布/上传/付费生成、不写正式工程、不删除未跟踪/evidence

## software_goal: multi-model-quality-20260813

- status: `completed`
- active_item: `none`
- completed:
  - [x] 四模型第一轮独立审查；GLM 首轮源码不可见如实记为 NOT_VERIFIED，未伪造结论
  - [x] Codex 复现并关闭总资源证据发布竞态与 VideoEditor 同批重复同步两个 P2
  - [x] Kimi 隔离 worktree 实现、Codex 审查集成；GLM/豆包/Grok 交叉复核并补齐两个负向路径
  - [x] Kimi、GLM、豆包、Grok 第三轮均绑定 `87c24e3b…` 并给出有效 PASS
  - [x] 定向 31 tests、全分区 389 files / 2411 tests、两套 typecheck、audit 0、build、MCP 220 全 PASS
  - [x] P17 22 路径、总资源分页/复用、T23 strict interactions 隐藏 Electron 实跑 PASS
  - [x] 模型越权写入已归档并还原，所有模型/测试/App 进程、临时锁和 Kimi 分支/worktree已清理
  - [x] 最终证据、报告、STATUS、TASKS、交接与本地提交收口；不 push
- correction_history:
  - Kimi CLI 不支持 `--plan + --prompt`；改用一次受支持调用
  - Grok 不支持 max reasoning；实际 high；首个错误冻结包 NOT_VERIFIED 后只纠正一次
  - GLM/豆包终审正文只做一次结构格式校正，结论与 findings 未改
- earliest_next: `none`；没有新复现不得重开已闭合整改或重跑全量
- installed_app: 历史 `954ac71a… / c7cb5cee… / 220`，本轮明确未安装 `87c24e3b…`
- boundaries: 无正式工程写入、外部生成、上传、付费、公证、发布、push 或安装
- evidence:
  - `docs/evidence/multi-model-three-round-final-20260813-87c24e3b.json`
  - `docs/验证报告_20260813_四模型三轮协同整改最终闭环_87c24e3b.md`

恢复时只读本区块；旧 `multi-model-quality-20260812` 的 blocked 项已被本轮关闭，不能作为新待办复活。

## software_goal: multi-model-quality-20260812

- status: `blocked`（候选实现和机械验收完成；四模型第三轮签字未全部有效）
- active_item: `none`
- completed:
  - [x] Kimi 隔离 worktree 完成 3 个前端提交，Codex 审查后逐个 cherry-pick
  - [x] 关闭总资源 tab/tabpanel、Review 历史、剪辑搜索、小说搜索 4 个 P2
  - [x] 4 files / 30 tests；两套 typecheck；分区审计；fast/medium/integration/heavy 合计 387 files / 2403 tests PASS
  - [x] production audit 0、build、manifest/live digest、MCP stdio 220/9/8、diff check PASS
  - [x] 隐藏 Electron P17：22 路径、7 UI 快照、0 page/console/external、show/focus 0、68ms 自然退出、无残留
  - [x] Kimi 与豆包第三轮绑定同一 `9a7fde1f…` 并给出有效 PASS
  - [x] GLM/Grok 失败通道已按真实状态登记，未静默换模型或伪造报告
- blocked:
  - [ ] GLM 5.2：两次 `EMPTY_TRUNCATED_DRAFT`，无可审计终审正文
  - [ ] Grok 4.5：第三轮输出多 JSON 拼接且引用不存在路径，不能计有效终审
- earliest_next: 若仍要求四模型 COMPLETE，只补 GLM/Grok 报告通道；不改源码、不重跑全量，同通道必须带来新证据，禁止原样循环
- boundaries: 不 push、不安装 App、不公证/发布、不生成/上传/付费、不写正式工程；本轮无性能代码，T23 NOT_RUN
- evidence:
  - `docs/evidence/multi-model-quality-closeout-20260812-9a7fde1f.json`
  - `docs/evidence/multi-model-quality-navigation-ui-20260812-9a7fde1f.json`
  - `docs/验证报告_20260812_四模型协同整改与机械验收_9a7fde1f.md`

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
