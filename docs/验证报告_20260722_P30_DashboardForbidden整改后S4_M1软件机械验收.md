# P30 Dashboard forbidden 整改后 S4 / M1 软件机械验收报告

- 日期：2026-07-22
- 执行者：GPT/Codex 主代理（唯一正式写入者）
- 规范：`.planning/P30_Codex无限画布完善与生图接管执行规范.md` §5 S4
- 结论：**S4=PASS · M1=SOFTWARE_ACCEPTED**
- 长期目标：**未完成**；U29 rev2 的新 Codex canary（A2）尚未派发或生图

## 冻结身份

| 字段 | 值 |
|---|---|
| sourceDigest | `e5c1bcb779552118e551286d45b392586d05fa7924e35680d69507e895e884dc` |
| sourceFiles / sourceBytes | 530 / 12,428,051 |
| version | 0.2.0 |
| buildId | `41e82a0b3924ce39e1e5a810fa4f6d20` |
| buildIdentityFingerprint | `97da7f515f87303aa34c56ff30408da949de772a9f864502c348c731faa519cc` |
| releaseManifestFingerprint | `ae13d227573cd516ff13c54bf490b63ae647b91d1116509303ed7f5b6416a187` |
| MCP 工具数 | **189** = release manifest = listTools = get_capabilities |

`349f…` 因 S7 真图暴露 adapter/import 缺陷而 superseded；`1c91…` 因 U29 rev2 正式重投影后暴露 Dashboard 将 forbidden 素投影到 continuity 而 superseded。旧报告、JSON 和截图全部保留。本报告只冻结当前 `e5c1…`。

## 正式 S4 链

| 步骤 | 结果 | 决定性统计 |
|---|---|---|
| typecheck | PASS | sourceStable=true |
| P30/Core/MCP/UI 定向 Vitest | PASS | **32 files / 171 tests** |
| npm test | PASS | **188 files / 1053 tests** |
| build:mcp / build:identity | PASS | manifest 绑定当前摘要/buildId/189 |
| MCP smoke 与动态三等 | PASS | manifest/listTools/capabilities=189 |
| electron-vite build | PASS | out/main + out/renderer |
| 隔离 userData unit-grid Electron | PASS | 生成/Review 两页机械旅程 |
| 规模 Electron | PASS | 77/1288/4235/10000；10 次切工程；FD Δ=0 |
| 正式 Core / 账本只读终检 | PASS | U29 rev2、新包零调用、U28 unknown 不变 |
| 双路只读终审 | PASS | 两路均 P0=0、P1=0、阻断/非阻断 P2=0 |

源码在每份有效 command record 前后稳定，末尾再独立复算三次，均为 `e5c1…` / 530 / 12,428,051。

## Dashboard forbidden 整改

正式 U29 rev2 重投影已成功，但只读 Core 复算发现 Dashboard 将 `presence=forbidden` 的素当作控制资产，错误给出 `record-continuity-state`。整改复用既有 Dashboard owner：在连续性和控制资产投影前排除 forbidden proposal，并新增回归测试。

整改后正式状态为：

- U29 revision=2，3 格 BindingSet 均 current；
- 每格 visible 仅朔 + 夜间石穴；forbidden 仅嘟嘟 + 素；
- continuity 只覆盖朔与夜间石穴，嘟嘟/素条目为 0；
- Dashboard nextAction=`execute-agent-imagegen`；
- unit-grid pack=`studio-generation-freeze-f0367581163a34b546fb5257a1e23100`，新包 dispatch/result/callIntent/plan node 均为 0；
- 旧 U29 rev1 raw/labeled 和 reject Review 保持 append-only；
- U28 仍为唯一 `generation_unknown`，候选 SHA 未变且未重试。

## Electron 与截图

- 生成页：`.planning/reviews/P30/evidence/p30-s4-e5c1bcb7-unit-grid-generation.png`，3456×2054，SHA `8f85751c…`
- Review 页：`.planning/reviews/P30/evidence/p30-s4-e5c1bcb7-unit-grid-review.png`，3456×2054，SHA `2a6f532a…`
- 规模截图：`docs/evidence/p30-s4-e5c1bcb7-managed-studio-scale-canvas-ui-smoke.png`，1728×1029，SHA `464944fc…`

主代理与独立终审均按原尺寸查看。证据只证明 UI、布局、解码和流程的机械可用性；`humanVisualAcceptanceClaimed=false`，不得冒充新 canary 人工视觉 PASS。

## 无效调用透明披露

1. 一次 `npm run build:electron` 因脚本不存在而在构建前失败；记录保留。项目正式合同是直接 `electron-vite build`，随后同摘要有效构建 PASS。
2. 一个辅助终检因本地没有 `better-sqlite3` 在导入阶段失败；未打开正式工程。随后 `final-core-integrity` PASS。
3. 两个辅助 `sqlite3 -readonly` 探针在 SQL 前打开失败；随后使用连接级 `PRAGMA query_only=ON` 的 `final-ledger-query-only` PASS。失败探针不列为通过证据。

上述均未改变产品源码或正式 Studio 状态，也不替代有效终验证据。

## 分项状态

| 分项 | 状态 |
|---|---|
| 软件 S4 / M1 | **PASS / SOFTWARE_ACCEPTED** |
| IPC / MCP / 前端 / Electron / 规模 | **PASS** |
| 《嘟嘟》隔离导入 / 历史 no-generation 回放 | **PASS（S5）** |
| 首次 canary 机械验收 | **PASS（S7 v1）** |
| 首次 canary 人工视觉验收 | **REJECTED（S7 v1）** |
| 旧 raw/labeled 与 Review | 已原子写入并正式 `reject`；旧链不可变 |
| S8 adapter/Binding/Dashboard 软件整改 | **PASS** |
| S8 正式 U29 rev2 重投影 | **PASS**；新包尚未派发 |
| S8 A2 新 canary | **NOT_STARTED** |
| U28 generation_unknown | 保持不变，未复制/晋升/Review/重试 |
| 视频包 | S5 U17 静态机械 PASS；真实视频模型 NOT_STARTED |
| 正式生产 | **PAUSED_PENDING_M2** |
| 安装包 | **NOT_STARTED**；`/Applications/AI 漫剧画布.app` 未触碰 |
| Git | 无 stage/commit/push/PR；无 HEAD；既有 index 保持 |
| P30 长期目标 | **未完成** |

## 唯一 nextAction

仅由 GPT/Codex 主代理从当前 Core 状态再次动态计算唯一 canary。当前只读结果指向 U29 rev2，但执行时不得硬编码；必须创建全新的 plan/run/dispatch/call 身份，取得一次且仅一次 `callAllowed=true` 后，才可启动一个全新隔离生图执行单元调用一次 Codex imagegen。此前继续保持零生图。

机器证据：`docs/evidence/final-validation-20260722-p30-s4-e5c1bcb7.json`。
