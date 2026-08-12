# P1 受管项目模式与小说工作区壳验收报告

## 结论

**P1 已完成。** 在同一稳定源码身份 `sourceDigest=f3e186cdaea97298dc7654a4f9729dd4b3d69e02c719e4708cc00a80c8a5c1d0`、`buildId=3b39d7592ceaaaeb65d709d64c33736d` 上，drama、novel、hybrid 三种真实 Electron 路由、hybrid 偏好重启恢复、feature flag 回滚、v1 兼容和旧 writer 阻断均通过。

本阶段仍只交付小说只读壳；没有创建 `manuscript/`、`story-bible/` 或 `.aicanvas/novel/`，正文写入从 P2 开始。

## 交付结果

| 合同 | 实际结果 |
|---|---|
| 旧 v1 工程 | 缺失 `workspaceMode` 时只在内存投影为 `drama`，不升级、不改写；纯 drama 新建仍写 schema v1 |
| novel / hybrid | 写 schema v2、`minimumWriterSchemaVersion=2`，进入独立 v2 registry |
| 顶层路由 | drama 进入现有 `MaterialStudioView`；novel 只进入 `NovelStudioView`；hybrid 在同一 root/projectId 间显式切换 |
| hybrid 偏好 | 独立保存于 v2 workspace-preferences sidecar；切换到 drama 后重启仍恢复 drama |
| 小说首页 | 真实显示总字数、卷/章、最近编辑、待确认事实、冲突、待回收伏笔、索引健康、备份状态 8 项 |
| 只读边界 | novel 与 hybrid 的小说壳项目树零变化；纯小说不会惰性创建 generation ledger 或小说事实目录 |
| 回滚 | `VITE_AI_CANVAS_NOVEL_WORKSPACE=0` 时 novel/hybrid 创建入口消失，创建结果保持 v1 drama |
| 旧 writer | 真实旧提交 `1e8e9d9c8cb055987d53b8fa0b503fb80538b3f5` 的已发货 UI/IPC 可达写路径均在写前失败关闭；项目树、registry、manifest、fence、cache 均未变 |

## 决定性证据

- `docs/evidence/novel-mode-v1/p1/final-v2/workspace-routing.json`：三模式路由、同 root/projectId 切换、重启恢复、8 状态、零外网请求、零 page/console error、小说壳零写均为 PASS。
- `docs/evidence/novel-mode-v1/p1/final-v2/feature-flag-off.json`：关闭入口后只创建 schema v1 drama，PASS。
- `docs/evidence/novel-mode-v1/p1/final-v2/old-writer-fence.json`：真实旧版本 activate、Story 导入、设置保存、布局读写与显式 root 写入均被阻断；备份副本同样零写，PASS。
- `docs/evidence/novel-mode-v1/p1/final-v2/commands/directed-tests.json`：15 files / 97 tests，exit 0，`sourceStable=true`。
- `docs/evidence/novel-mode-v1/p1/final-v2/commands/typecheck.json`：完整 typecheck，exit 0，`sourceStable=true`。
- `docs/evidence/novel-mode-v1/p1/final-v2/commands/partition-audit.json`：325 个测试文件分区完整（195 fast / 90 medium / 35 integration / 5 heavy），exit 0。
- `docs/evidence/novel-mode-v1/p1/final-v2/commands/isolated-build.json` 与 `feature-off-build.json`：两套隔离 `npm run build` 均通过，PID 51269、live `dist-mcp` 和 live release manifest 前后不变。
- `MaterialStudioView.vue` SHA-256 仍为 `6520eacb2c17deb9f8f03caf5b98d0ed1ba2fa48ad534d93bbda6450706d4409`，P1 未改既有短剧工作台实现。

## 人工视觉复核

已按原始 1728×1029 尺寸逐张查看：

- `drama-workspace.png`：旧短剧五阶段工作台、工具栏和画布正常，无小说壳混入。
- `novel-workspace.png`：小说只读横幅、8 项状态、左侧工作区、中央只读占位与右侧关注区完整，无 MaterialStudio。
- `hybrid-novel-before-switch.png`：顶部小说/短剧显式切换器可见，默认处于小说创作。
- `hybrid-drama-after-restart.png`：重启后保持短剧制作，同一工程显示既有 MaterialStudio。
- `feature-flag-off-drama.png`：回滚构建进入纯短剧界面，没有 novel/hybrid 创建入口。

未见重叠、裁切、空白错误态、错误路由或视觉破版。截图仅证明 P1 壳层与路由，不冒充 P2 之后的正文编辑能力。

## 写入边界说明

小说只读壳的零写门只覆盖小说视图。hybrid 用户明确切换到既有短剧工作区后，MaterialStudio 正常打开 `.aicanvas/studio-generation-ledger.sqlite`，会产生该数据库及 WAL/SHM 的正常变化；Electron 证据机械限定变化只能落在这组既有 generation-ledger 文件，其他项目路径仍失败关闭。

旧 writer 的验收威胁模型是“旧产品已发货 main/preload/UI/IPC 可达写路径”。人为直接 import 旧 Core 内部原语（如 `appendEvent`、`saveOverrides`、`saveIndex`）不属于该产品可达面，本报告不声称它们被全局阻断。若未来威胁模型扩展为任意旧内部函数调用，应另立迁移阶段，把相应 owner 全部迁至 v2-only namespace。

## 正式目录与运行态保护

- 正式小说目录最终只读 aggregate：`b7afb7aa236d37f3f1654f8a1ecc1da75da2891dfdbd952714fa869c421c227c`，与 P0 完全一致（1,353 entries）。
- 活动生产工程最终只读 aggregate：`5395f2cbc2aead35812fa0984f04e65489db91956a2fdfd2a4239903d149b0b5`，与 P0 完全一致（838 entries）。
- PID 51269 仍运行原 live `dist-mcp/mcp/server.js`；live release manifest SHA-256 仍为 `e82a92ac2d96c02328847db41186dce4af3920bcb00a42333a96b0a04de22132`，live `dist-mcp` 聚合仍为 `35e62643f2ab390f9ebd681a85bfff3eaec1da36ffb7faed4ed2cf1553142c83`。

## 下一阶段

P2 将在 P1 的 v2 项目边界内实现 `NovelRepository`、安全只读预检、导入副本、稳定章节 UUID、相对 locator、CAS 保存、DOCX 隔离解析和 story v1→v2 迁移；不会把本阶段占位壳当成正文能力。
