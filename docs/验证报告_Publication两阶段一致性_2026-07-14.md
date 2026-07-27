# Publication 两阶段一致性验证报告

验证时间：2026-07-14 02:48（Asia/Shanghai）  
工作区：`/Users/hxx/Documents/无限画布`

## 结论

交接文件原列的唯一 P0“Publication 注册两阶段校验”在实施前仍真实成立：`registerPublication` 把 ffprobe、Sharp、全文件 SHA-256、状态提交和回执写入包在同一个 `publications` 项目锁内。该缺口现已完成完整纵向切片：

- 短锁内读取 PublicationIntent/receipt、修订、令牌、状态、不可变字段以及瞬态路径/文件身份；
- 锁外执行 Sharp、受机器运行时治理的 ffprobe，以及固定 `O_NOFOLLOW` FileHandle 的分块 SHA-256；
- 短锁内重新读取并按单 intent 与强文件身份 CAS 提交，不使用全局 PublicationStore revision 阻塞无关预检；
- 不新增持久 `validating` 状态；锁外崩溃保持 `reserved`，无锁、无回执，可由下一进程重试；
- 取消、失败或并发终态优先于旧校验结果；文件漂移保留 `reserved`，稳定机械失败才闭合为 `failed`；
- 两个进程并发注册同一 intent 只生成一份 receipt，另一方复验后返回相同回执；
- 已登记重放与剪辑渲染恢复都会复验当前文件，不能只凭 receiptId 宣告成功；
- 命令账本新增已确认 `failed` 终态，Publication 已持久化的机械失败不再成为永久 `unknown`。

本轮没有扫描或修改正式 AI 漫剧项目，没有登录网站、上传、付费提交、覆盖现有 DMG、安装、发布或公证。

## 实际修改

- `src/core/publication.ts`
  - 三阶段 snapshot → validate → CAS；
  - canonical root/parent 与 dev/ino/mode/nlink/size/mtimeNs/ctimeNs 瞬态身份；
  - 固定 fd SHA-256、总超时、registered 重放复验；
  - 并发单回执、取消优先、文件漂移保留 reserved、稳定失败闭合。
- `src/core/command-outcome.ts`、`src/core/command-bus.ts`
  - confirmed failed 类型、账本 `failed` 状态、精确失败终态证据与失败对账；
  - 原幂等键明确拒绝重跑，真正不确定的副作用仍保持 `unknown`。
- `src/core/editor.ts`
  - 删除已登记 receiptId 绕过当前文件哈希复验的恢复快捷路径。
- `src/core/codex.ts`、`src/mcp/server.ts`
  - `get_capabilities.publication.registrationConsistency`；
  - Doctor 使用“目标已出现但仍待机械校验”语义；
  - 统一快照返回脱敏状态计数与待校验项，不返回令牌或瞬态指纹；
  - register 工具描述明确锁外校验与 CAS。
- `tests/publication.test.ts`、`tests/codex.test.ts`、`tests/mcp-scan-cancel.test.ts`
  - 取消竞态、无关预检、同 intent 双快照、同尺寸同 mtime rename、跨进程、崩溃、篡改重放、超时清理、confirmed failed 与 MCP 合同。
- `scripts/publication-register-worker.ts`、`scripts/publication-consistency-smoke.ts`
  - 独立进程注册/崩溃 worker；真实 FFmpeg/ffprobe 一致性 smoke。
- `README.md`、`docs/CODEX_MCP.md`、`package.json`
  - 固化运行合同与可复现 smoke 命令。

## 并发和恢复语义

### 1. 文件 CAS

瞬态指纹不会写入业务侧车。即使替换文件保持相同 size，并用 `utimes` 恢复原 mtime，rename 后的 inode/ctime 仍会让提交 CAS 失败。旧结果不会注册；intent 保持 reserved，调用方重新读取当前文件后可用相同修订重试。

### 2. Intent CAS

提交只比较当前 intent 的 revision、reservationToken、status、targetPath、allowedRoot、kind、variant 与 projectId。锁外期间其他 intent 的预检可以正常提交；全局 store revision 变化不会误杀当前注册。

### 3. 并发注册

两方都从 reserved 取得快照时，首个提交者创建唯一 receipt；后来者看到 registered 后必须用自己的机械结果与当前 receipt 的 SHA/size 对账，完全一致才返回同一 receipt。若第二进程在首个提交后才取得锁，允许将 `expectedRevision + 1` 的唯一 registered 转换识别为并发幂等重放，但仍完整复验当前文件。

### 4. 取消和崩溃

ffprobe/SHA 不持有 `publications` 锁，取消和无关预检可及时取得锁。取消完成后，旧验证只能返回状态冲突。宿主在校验完成、提交前被 SIGKILL 时，侧车仍为 reserved；项目锁为 0、receipt 为 0，重启后可恢复。

### 5. 命令终态

稳定机械失败会先持久化 Publication failed，再以 `ConfirmedCommandFailure` 进入命令账本 `failed`，并写入带 requestHash、command、resultDigest、outcomeStatus 的终态证据。`reconcile_command` 可返回 confirmed failed；相同幂等键不会重放。无法证明业务是否提交的异常仍使用 unknown，安全边界没有放宽。

## 自动化验证

| 门禁 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过 |
| Publication/CommandBus/Editor/Codex 定向门禁 | 4 个文件、41 项通过 |
| 源码 MCP Publication 合同 | 1/1 通过 |
| 编译 MCP Publication 合同 | 1/1 通过 |
| `npm test` | 29 个测试文件、157 项通过，54.84 秒，最多 2 workers |
| `npm run build` | main、preload、renderer、dist-mcp 全部通过 |
| `npm run mcp:smoke` | 133 tools、9 Resource Templates、7 Prompts |
| `npm run publication:consistency-smoke -- docs/evidence/publication-consistency-smoke-20260714.json` | 成功 |

## 真实 FFmpeg/ffprobe 证据

专项证据：[publication-consistency-smoke-20260714.json](./evidence/publication-consistency-smoke-20260714.json)

- 临时隔离项目真实生成 1 秒、640×360 H.264；211,328 bytes；SHA-256 `1424ce5844e205dbfe747e8a1d5c303bb50fa86100df8e4672270f572794d207`；
- 回执记录 width 640、height 360、duration 1、decodable true，幂等重放返回同一 receipt；
- 锁外验证到达提交窗后，无关预检 17ms 完成；
- 延迟包装器最终调用真实 ffprobe，验证期间取消 15ms 完成，旧校验返回 cancelled 状态冲突；
- 同尺寸、恢复 mtime 的 rename 替换被强文件 CAS 拒绝，重试只登记新内容 SHA；
- 两个独立 Node 进程得到同一 receipt，唯一回执数为 1；
- 真实视频校验完成后、提交前 SIGKILL：状态 reserved、项目锁 0，重试成功；
- 终态 4 个 registered、2 个 cancelled、0 个 reserved/failed，4 份 receipt；项目锁 0、机器媒体活动权重 0、队列 0。

## 已知边界

- SHA 分块读取的总超时默认为 120 秒，可用 `AI_CANVAS_PUBLICATION_HASH_TIMEOUT_MS` 调整；普通本地文件的单次内核读无法在 JavaScript 层强制抢占，但超时后不会提交回执。
- POSIX `O_NOFOLLOW` 已在当前 macOS arm64 验证；其他平台没有本轮运行证据。
- 真正外部程序若绕过 PublicationIntent 直接改写文件，系统无法阻止写入，但 registered 重放、剪辑恢复和后续扫描不会把旧回执当成当前文件事实。
- 当前签名 DMG 仍是上一源码快照，本轮未覆盖、未安装、未发布、未公证。

## 下一唯一最高优先级

外部 Provider/生成网站和正式项目校准仍是 P0，但均等待用户给出明确对象与授权；Apple 公证也等待凭据和分发授权。当前可安全继续的唯一最高本地缺口是 P1“自定义贝塞尔关键帧曲线”纵向切片：统一数据 Schema、核心校验、桌面预览与 FFmpeg 渲染插值，提供可编辑控制点并覆盖持久化、撤销重做、分数帧率、UI 和真实渲染证据。复杂 OTIO 嵌套/效果兼容继续明确拒绝，不能借此声称等同专业 NLE。

机器可读永久证据：[final-validation-20260714-0243.json](./evidence/final-validation-20260714-0243.json)。
