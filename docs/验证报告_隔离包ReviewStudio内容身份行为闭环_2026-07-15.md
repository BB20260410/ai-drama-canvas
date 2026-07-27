# AI 漫剧无限画布 · 隔离包 ReviewStudio 内容身份行为闭环验证报告

验证日期：2026-07-15（Asia/Shanghai）  
验证范围：当前源码构建的临时 arm64 unpacked App、packaged MCP、ReviewStudio、完整 App 重启、独立证据与清理门禁  
结论：通过。长期目标保持 `active`，本报告不关闭正式真实项目 NLE 校准。

## 1. 优先级核验

恢复当前文件系统后，`docs/当前开发交接.md` 所列“长期事实写路径 revision CAS P0”已不再成立：CAS 已在上一切片完成 Core、Command Bus、source/compiled MCP、IPC/Renderer、双 Electron 与 241 项全量测试。

上一份 final evidence 仍明确记录 `packagedReviewStaleSubmitBehaviorSpecificallyValidated=false`。此前 package 只证明 manifest 包含 Review 源码，并实跑 Effect/Transition 页面；source Review UI 也不能替代真实 packaged executable。故本轮唯一 safe-local P0 是：在当前源码隔离 package 中闭环 ReviewStudio 旧快照提交、完整 App 重启与再次同路径漂移。

本轮完成后，独立只读审计与当前能力合同一致：`missingForFullNle=["real-project-nle-validation"]`，没有新的可证明 safe-local P0/P1。下一唯一产品级优先级回到 P1“正式 AI 漫剧项目 NLE 校准”，状态 `waiting_authorization`。

## 2. 实现切片

- `scripts/ui-review-content-identity-smoke.mjs` 支持显式 `AI_CANVAS_ELECTRON_EXECUTABLE`，可在 source Electron 与 packaged executable 之间复用同一业务断言。
- packaged 模式使用独立 project、registry、`--user-data-dir`、HOME、TMPDIR 与媒体 runtime；完整关闭 App 后重新启动，而不是仅刷新页面。
- `scripts/isolated-package-smoke.ts` 在当前源码临时 App 中依次运行 packaged MCP、空项目 fresh restart、Effect/Transition UI 与 ReviewStudio UI。
- ReviewStudio 生成独立 `*-review-ui.json` / `*-review-ui.png`，总 evidence 绑定两者 SHA-256、transport、业务断言和终态清理。
- `scripts/isolated-package-guards.ts` 与 `tests/isolated-package-guards.test.ts` 强制 packaged transport、真实 executable、全部业务断言、0 page errors、1560×980、截图大于 20KB 与完整清理，防止测试悄悄退回 source Electron。

## 3. 首次安全失败与最小修复

首次显式运行 `isolated-package-review-content-identity-20260715-0038.json` 在 packaged Review 启动前失败，未保留通过证据。

根因是 packaged 子进程的 `TMPDIR=<tempRoot>/tmp`，而 Review project、registry、user-data 当时位于其同级 `<tempRoot>/...`。内层 `isTemporaryPath` 因此正确失败关闭。

修复仅把三条 Review 路径迁入 `isolatedTmp`，没有放宽路径门禁。失败运行的 tempRoot 与派生 evidence 均被清理；随后 typecheck、guard 和完整 package 重新运行通过。

## 4. packaged ReviewStudio 真实行为

命令：

```bash
npx tsx scripts/isolated-package-smoke.ts docs/evidence/isolated-package-review-content-identity-20260715-0041.json
```

真实 transport 为 `packaged-electron-current-source`。直接证据证明：

1. 页面持有旧 SHA 时，同路径素材变化后的提交被 UI 拒绝；
2. 旧提交没有写入 ReviewRecord；
3. UI 自动载入新的权威 SHA，并清空旧检查项；
4. 对新内容重验通过后状态进入“待视频”；
5. 完整关闭并重启 App 后，同一 review ID 与同一 SHA 的 pass 被恢复；
6. 第二次同路径漂移保持稳定 artifactId，但 SHA 改变，旧 pass 不再算当前；
7. 状态回到“待视觉验收”，缓存地址变化，历史 ReviewRecord 保留；
8. `pageErrors=0`。

包内同时得到 134 tools、2 个静态 Resources、9 个 Resource Templates、7 个 Prompts；Effect/Transition stdio、空项目 fresh restart 与 packaged Effect/Transition Electron 仍通过。

## 5. 视觉验收

主代理以原始分辨率人工目视 `docs/evidence/isolated-package-review-content-identity-20260715-0041-review-ui.png`：完整应用顶部导航、导演验收标题/队列、当前待视觉状态、A/B 两张有效素材、右侧 1/7 检查项、历史/刷新与底部操作均清晰；不是黑屏、空白、占位图或错页。

机械指标：1560×980、227,544 bytes；全图 bright ratio 约 21.22%，chromatic ratio 约 14.99%，顶部/左侧/右侧亮像素覆盖约 4.99%/4.92%/7.86%。

## 6. 测试与构建

| 门禁 | 结果 |
| --- | --- |
| 定向 Vitest | 6 files / 68 tests passed |
| Package guard | 1 file / 6 tests passed |
| `npm run typecheck` | passed |
| `npm run build` | Electron main/preload/renderer + compiled MCP passed |
| Source Review UI | 全部 stale/pass/restart/drift/history 断言通过，0 pageerror |
| source/compiled CAS MCP | 两模式各 134 tools，passed |
| current-source isolated package | passed |
| 全量 Vitest | 39 test files、78 suites、242/242 tests，0 failed、0 pending |

全量结构化 reporter 位于 `/tmp/ai-canvas-full-vitest-packaged-review-20260715.json`，90,256 bytes，SHA-256 `4d6a90a91994c3327cd0d1b77601a3868d7e60ed0b0b2fbcc2c1812ee5b3c332`；它是临时原始测试日志，不作为工作区永久业务 evidence。

## 7. 永久证据身份

| 文件 | bytes | SHA-256 |
| --- | ---: | --- |
| `isolated-package-review-content-identity-20260715-0041.json` | 36,340 | `484bdfe80dd2d91d8bf0db71959b6a6dd6af6260fa84644edb38a3d85b840304` |
| `isolated-package-review-content-identity-20260715-0041-review-ui.json` | 5,466 | `83251c96e109d92d2091faa2c971168fde189a525e7db225dd800fd152cee78d` |
| `isolated-package-review-content-identity-20260715-0041-review-ui.png` | 227,544 | `05b85a55b9971db54ababf067dbaff013a7d9359c061d692826eea3ac23bfc5f` |

同次运行的 packaged Effect/Transition evidence 仍独立保存在 `*-electron-ui.json/png`，没有拿它替代 ReviewStudio 证据。

## 8. 清理与授权边界

- 临时 App、tempRoot、project、registry、user-data、媒体 runtime 与相关进程均已清理。
- 宿主 registry、宿主媒体 state、工作区 `dist/out/dist-mcp` 前后身份不变。
- 旧 DMG 仍为 136,652,595 bytes，SHA-256 `ee7c78f16104b3881650353052669fa60c8fd4deb196cc5f49a2f1c765a20972`；没有生成、覆盖、安装、签名、公证或发布。
- 没有扫描、导入或修改正式 AI 漫剧项目；没有访问网站、上传或付费。
- Git 仍为 `main`、No commits yet、全项目 untracked；未 stage、commit、push 或创建 PR。

## 9. 下一唯一优先级

下一唯一产品级优先级：P1“正式 AI 漫剧项目 NLE 校准”，状态 `waiting_authorization`。

执行前必须由用户明确提供：

1. 正式项目绝对路径；
2. 只读权威源或可写副本边界；
3. 允许的新工程、成片和证据输出目录；
4. 是否允许扫描、导入，以及任何覆盖边界。

在获得这些授权前，不得用 fixture、更多 package 重跑或重复建设内容身份、CAS、关键帧、嵌套、Effect/Transition 等已验证模块来伪装继续推进。长期 goal 保持 `active`，不能清空 `real-project-nle-validation`，也不能宣告整体完成。
