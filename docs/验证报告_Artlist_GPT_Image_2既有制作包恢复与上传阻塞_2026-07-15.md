# Artlist GPT Image 2 既有制作包恢复与上传阻塞验证报告

验证时间：2026-07-15 10:45；11:18、11:42、13:23 续审（Asia/Shanghai）  
工作区：`/Users/hxx/Documents/无限画布`  
正式隔离项目：`/Users/hxx/Documents/无限画布/formal-calibration/fengshen-bcbd8aca-20260715-0729`  
状态：**本地纵向切片通过；真实网站生成尚未完成；同一人工参考图上传阻塞连续三轮成立，长期 Goal 转为 blocked 等待恢复。**

## 1. 结论

本轮没有把 Artlist 生成伪装成完成。filesystem 既有制作包此前缺少可审计的生产工作流接管入口，真实图片入队被统一门禁正确拒绝；现已完成“只读预检 → CAS/幂等提交 → 内容寻址 scoped baseline → Doctor/MCP → 正式 job/浏览器计划”的完整本地纵向切片，并修复 image first-frame 参考图被错误降级成 text/空上传白名单的问题。

Artlist 可见页面已确认 GPT Image 2、16:9、Medium、1 Image、Unlimited，无另购额度动作；结构化预检已持久化为 job `preflight r2`。但 Codex In-app Browser 明确拒绝 filechooser，二进制会话剪贴板写入也未落地，因此参考图没有上传，Generate 没有点击，下载目录仍为空，额度消耗为 0。

11:18 续审时，原 IAB 标签页已丢失；Codex 只重新打开同一 Artlist 地址，既有登录会话仍可用。新标签页没有参考图缩略图，网站实际控件回到默认 `Nano Banana 2 / 16:9 / 2K / 1 images`。模型控件的语义点击和一次短时 DOM 诊断均超时，重连后仍无可证明的模型变更；因此冻结 job 仍保持 `preflight r2`，未把网页默认值或超时尝试写成已配置、已上传或已提交。

11:42 第三次续审中，产品运行态仍为 Doctor healthy（0 error / 1 warning / 24 ok）、同一 job `waiting_external / preflight r2`、poll/download 均为 0、当前 Publication 仍 `reserved r1`。侧边浏览器中同一 Artlist 页面仍存在（tab 3，`https://toolkit.artlist.io/new?mode=image`），但一次 viewport screenshot 和一次仅投影模型/参考图信号的只读 DOM 读取分别超时并重置控制内核；没有点击、输入、上传或提交。由于当前页面内容无法可靠读取，不能声称 11:18 后已出现缩略图或已切换模型；最后一份可见证据仍是“无缩略图、默认 Nano Banana 2”。同一人工上传阻塞至此已连续三轮确认，且没有安全自动旁路。

13:23 用户发送普通“继续”后的 continuation audit 中，运行时 Goal 现场仍为 `blocked`，没有自动恢复为 active。IAB 当前会话和用户开放标签页均为空；为只读核验页面是否可恢复，分别导航用户原始 URL 与已知最终 URL，两次都超时并重置控制内核，重连终态只有 `about:blank`。空白标签已清理，全程没有刷新已有业务页面、点击、输入、上传或提交。产品侧 Doctor 为 0 error / 2 warnings / 24 ok（预期 scoped baseline 与锁定账本各 1 条），同一 job 仍为 `waiting_external / preflight r2`，Publication 仍 `reserved r1`，下载目录仍为 0 文件。因此本次只构成 blocked 后 continuation audit #1，不形成 `uploaded` 或新的 Goal blocked 计数。

本报告不是新的 `final-validation`。上一完整成功基线仍是 `docs/evidence/final-validation-20260715-0759.json`；当前阶段 81 继续进行中。

## 2. 完成的产品纵向切片

- 新增显式 `preview_existing_production_recovery` / `commit_existing_production_recovery`：预检零写入，提交使用 workflow CAS 与跨进程幂等命令账本。
- baseline 不把 15 个历史阶段伪造成 completed；正式项目 workflow 为 r1，全部普通阶段仍是 `not_started`。
- baseline 只覆盖 `main-ep22-unit001` 的 `image`，未覆盖其余 139 个既有节点，也未授权普通 video。
- GenerationJob 冻结 baseline id/digest、9 秒正式分镜合同、参考素材 ID/路径；读计划、处理队列和写网页检查点前都会重新校验 baseline 与文件 SHA。
- Doctor 在接管前报告 error；接管后为 scoped warning，未覆盖节点继续失败关闭。
- 显式 `createTaskPack(itemIds)` 同样走统一 workflow gate，关闭相邻 scope 绕过。
- 修复 `generationParameters()`：image 存在结构化 `first_frame` 时优先协商 first-frame 模式；Artlist 计划现只允许上传一张原始 raw，并冻结 role/order/SHA。

正式 baseline：

- ID：`existing-production-bf0c4369018aedbc8e6a402f`
- digest：`bf0c4369018aedbc8e6a402f6b03ac1d4a18f7d035a634bed1494360dd8a90cc`
- evidence fingerprint：`1020289bdcb9b65cdc981710ed6df7f7576e97dfd144a426b61d9d8f9e5291de`
- Doctor：healthy，0 error / 1 warning / 24 ok；唯一 warning 为 1 条未确认幂等命令账本记录，相同键已锁定，不会盲重放

## 3. 当前真实网页任务

- Job：`gen-2026-07-15T02-22-13-148Z-3e0a0e68`
- Provider：`artlist-gpt-image2-browser`
- 状态：`waiting_external`
- 检查点：`preflight r2`
- 参数：GPT Image 2 / first_frame / 16:9 / Medium / 1 Image
- externalTaskId：不存在
- raw/labeled 输出：均不存在
- downloads 文件数：0

唯一白名单参考图：

- `/Users/hxx/Documents/无限画布/formal-calibration/fengshen-bcbd8aca-20260715-0729/EP22_15s_001_缓推·大远景·新朝刑场/EP22_15s_001_首帧_raw.png`
- 1920×1080，221,423 bytes
- SHA-256：`d6718fb6b65e71e3bd69939cd3e6724c227af4cfc1610960362c50ab2d0939cc`
- 角色：`first_frame`，顺序：0

可见预检截图：

- `formal-calibration/fengshen-bcbd8aca-20260715-0729/evidence/artlist-gpt-image2-ep22-001-20260715-084108/browser-evidence/artlist-composer-ready.png`
- 370×943，35,723 bytes
- SHA-256：`c9e0e945bba1472fad39c0db1c37e405ed9de1f46efa83c3cd9ca5944ebc208b`
- 该截图证明 composer/Image Reference/Image 模式/Unlimited 可见且无错误或购买弹窗；不证明上传、提交或下载。

## 4. 上传阻塞证据

按 Browser 插件规范尝试标准文件选择器能力时，IAB 返回：

`File uploads are not supported by Codex In-app Browser.`

未点击 Image Reference，未打开原生 picker，未传输文件。随后只在 Node 内存准备唯一白名单 PNG，尝试写入该标签页二进制剪贴板；调用超时后以新 kernel 只读对账，clipboard item 数为 0。未发送 Meta+V，也未把 base64 打印到终端或报告。

因此以下动作均没有发生：

- reference upload
- uploaded 检查点
- submit_intent
- Generate 点击
- 远端 task/session 创建
- 下载、Publication、画布回填或 ReviewStudio 验收
- 购买额度或任何付费动作

## 5. 验证结果

| 门禁 | 结果 |
| --- | --- |
| 定向 recovery 测试 | 1 file / 5 tests，通过 |
| TypeScript | `npm run typecheck`，通过 |
| 全量测试 | 41 files / 252 tests，通过，exit code 0 |
| Production build | Electron main/preload/renderer + dist-mcp，通过 |
| MCP 工具数 | 136；新增两个 recovery 工具 |
| 正式源零回写 | 30 files / 2,436,824 bytes / 23 集 / 968 镜 / 8,637s；aggregate SHA 与 0759 一致，无 `.aicanvas` |

13:25 continuation audit 在未修改产品源码的前提下重新运行 scoped recovery 定向门禁（1 file / 5 tests）与 `npm run typecheck`，两者 exit 0。没有机械重复全量、package 或 DMG；此前 41 files / 252 tests 与 production build 仍作为本切片实现后的权威广泛门禁。

完整机器可读证据：`docs/evidence/artlist-gpt-image2-ep22-001-paused-20260715-1045.json`。

## 6. blocked 状态与下一唯一恢复动作

长期 Goal 不是完成，而是因同一外部阻塞连续三轮成立而进入 `blocked`。本地代码、测试和任务状态均无可替代的更高优先级缺口；重复创建 job、重复入队、绕过上传白名单或把页面超时写成 checkpoint 都会破坏既有安全合同。

用户需重新打开已登录的 Artlist 图片页并完成一次人工页面准备：

1. 打开 `https://toolkit.artlist.io/image-video-generator?mode=image` 并确认仍为既有登录态；
2. 把模型改为 `GPT Image 2`；
3. 点击 `Image Reference`；
4. 选择上述唯一白名单 raw 路径；
5. 确认页面出现且只有一个参考缩略图；
6. **不要点击 Generate**，显式执行 `/goal resume`。

之后继续同一个 job，先核验 GPT Image 2 与唯一缩略图，再以 expectedRevision=2 写 `uploaded` 证据；随后填入已冻结提示词，复核 16:9 / Medium / 1 Image，写 `submit_intent` 后只点击 Generate 一次。禁止重新入队，禁止复用已取消的旧 job `gen-2026-07-15T02-19-47-844Z-d8975bed`，禁止点击 `Get More Credits`。
